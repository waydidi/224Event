import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { splitSqlQuery } from "./sql.ts";
import { Store } from "../../src/cloudflare/database.ts";
import * as domain from "../../src/cloudflare/domain.ts";
import { loadConfig } from "../../src/config.ts";

export const INTERNAL = "test-internal-token",
  WEBHOOK = "test-webhook-secret",
  CHAT = "-100777";
export async function setup(opts: { width?: number; charges?: boolean } = {}) {
  const calls: { method: string; body: any }[] = [];
  let failing = false,
    seq = 100;
  const root = path.resolve("dist/worker");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "224-test",
          modulesRoot: root,
          modules: fs
            .readdirSync(root)
            .filter((p) => /\.(js|ttf|png)$/.test(p))
            .sort(
              (a, b) => Number(b.endsWith(".js")) - Number(a.endsWith(".js")),
            )
            .map((p) => ({
              type: p.endsWith(".js")
                ? ("ESModule" as const)
                : ("Data" as const),
              path: path.join(root, p),
            })),
          compatibilityDate: "2026-10-17",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "test" },
          bindings: {
            INTERNAL_API_TOKEN: INTERNAL,
            TELEGRAM_BOT_TOKEN: "test-token",
            TELEGRAM_STAFF_CHAT_ID: CHAT,
            TELEGRAM_WEBHOOK_SECRET: WEBHOOK,
            TELEGRAM_API_BASE: "https://telegram.test",
            RECEIPT_WIDTH_MM: String(opts.width ?? 80),
            ...(opts.charges
              ? { SERVICE_CHARGE_BPS: "1000", VAT_BPS: "700" }
              : {}),
          },
          serviceBindings: {
            ASSETS: async (req) => {
              const name = new URL(req.url).pathname;
              const file = path.join(process.cwd(), "public", name);
              if (!fs.existsSync(file))
                return new Response("Not found", { status: 404 });
              return new Response(fs.readFileSync(file), {
                headers: {
                  "content-type": name.endsWith(".js")
                    ? "text/javascript"
                    : name.endsWith(".css")
                      ? "text/css"
                      : name.endsWith(".webp")
                        ? "image/webp"
                        : "text/html",
                },
              });
            },
          },
          outboundService: async (req) => {
            const method = new URL(req.url).pathname.split("/").at(-1)!;
            const b = req.headers
              .get("content-type")
              ?.startsWith("application/json")
              ? await req.json()
              : { document: await req.text() };
            calls.push({ method, body: b });
            if (failing && method !== "answerCallbackQuery")
              return Response.json(
                {
                  ok: false,
                  description: "Too Many Requests",
                  parameters: { retry_after: 1 },
                },
                { status: 429 },
              );
            return Response.json({
              ok: true,
              result:
                method === "sendMessage" || method === "sendDocument"
                  ? { message_id: seq++ }
                  : true,
            });
          },
        },
      ],
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const file of fs
    .readdirSync("migrations")
    .filter((p) => p.endsWith(".sql"))
    .sort()) {
    const statements = splitSqlQuery(
      fs.readFileSync(path.join("migrations", file), "utf8"),
    );
    if (statements.length) await db.batch(statements.map((s) => db.prepare(s)));
  }
  const c = {
    db: new Store(db as unknown as D1Database),
    config: loadConfig({ TELEGRAM_STAFF_CHAT_ID: CHAT }),
    now: () => new Date(),
  };
  const api = async (
    p: string,
    body?: any,
    token?: string,
    extra: Record<string, string> = {},
  ) => {
    const res = await mf.dispatchFetch(`http://224.test${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = res.headers.get("content-type")?.includes("json")
      ? ((await res.json()) as any)
      : null;
    return { res, status: res.status, data };
  };
  for (const [id, role] of [
    [1001, "server"],
    [2002, "cashier"],
    [3003, "lead"],
  ] as const)
    assert.equal(
      (
        await api(
          "/api/internal/configure",
          { operation: "staff", telegramUserId: String(id), name: role, role },
          INTERNAL,
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await api(
        "/api/internal/configure",
        { operation: "tables", count: 3 },
        INTERNAL,
      )
    ).status,
    200,
  );
  const menu = (await api("/api/internal/menu", undefined, INTERNAL)).data
    .categories;
  for (const i of menu.flatMap((x: any) => x.items))
    assert.equal(
      (
        await api(
          "/api/internal/configure",
          { operation: "price", code: i.code, priceSatang: 25000 },
          INTERNAL,
        )
      ).status,
      200,
    );
  const tables = (await api("/api/internal/tables", undefined, INTERNAL)).data
    .tables;
  let updateId = 1000;
  const webhook = async (update: any) =>
    api(
      "/api/integrations/telegram/webhook",
      { update_id: ++updateId, ...update },
      undefined,
      { "x-telegram-bot-api-secret-token": WEBHOOK },
    );
  const flush = async () => {
    await mf.ready;
    // waitUntil deliveries may own the lease; explicitly drain once it releases.
    for (let i = 0; i < 100; i++) {
      await api("/api/internal/outbox/drain", {}, INTERNAL);
      const lease = await db.prepare("SELECT * FROM worker_leases").all();
      const inbox = await db
        .prepare(
          "SELECT * FROM telegram_inbox WHERE processed_at IS NULL AND next_retry_at<=?",
        )
        .bind(new Date().toISOString())
        .all();
      const pending = await db
        .prepare(
          "SELECT * FROM outbox_events WHERE delivered_at IS NULL AND next_retry_at<=?",
        )
        .bind(new Date().toISOString())
        .all();
      if (
        !lease.results.length &&
        !inbox.results.length &&
        !pending.results.length
      )
        return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Outbox did not quiesce");
  };
  const command = async (text: string, user = 2002, chat = Number(CHAT)) => {
    await webhook({
      message: {
        message_id: updateId,
        chat: { id: chat, type: "supergroup" },
        from: { id: user },
        text,
      },
    });
    await flush();
  };
  const callback = async (action: string, user = 2002, chat = Number(CHAT)) => {
    await webhook({
      callback_query: {
        id: `cq${updateId}`,
        from: { id: user },
        message: { message_id: 100, chat: { id: chat, type: "supergroup" } },
        data: `a:${action}`,
      },
    });
    await flush();
  };
  const join = async (n = 1) => {
    const s = await db
      .prepare(
        "SELECT * FROM table_sessions WHERE table_id=? ORDER BY id DESC LIMIT 1",
      )
      .bind(tables[n - 1].id)
      .first<any>();
    const r = await api("/api/public/session/join", {
      qrToken: tables[n - 1].permanent_qr_token,
      pin: s!.join_pin,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.visitToken as string;
  };
  return {
    mf,
    db,
    c,
    api,
    calls,
    tables,
    menu,
    webhook,
    command,
    callback,
    flush,
    join,
    setFailing: (value: boolean) => {
      failing = value;
    },
    close: () => mf.dispose(),
  };
}
