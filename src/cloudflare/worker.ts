import { loadConfig } from "../config.ts";
import { AppError, badRequest, notFound } from "../lib/errors.ts";
import { safeEqual, sha256 } from "../lib/ids.ts";
import { redact } from "../lib/log.ts";
import { Store } from "./database.ts";
import * as d from "./domain.ts";
import { drain } from "./outbox.ts";
import { generateReceipt, readPdf } from "./receipt.ts";
import type { Env } from "./types.ts";

const security = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
export function context(env: Env, origin = "https://224event.invalid"): d.Ctx {
  const vars = Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  return {
    db: new Store(env.DB),
    config: loadConfig({
      ...vars,
      PUBLIC_BASE_URL: vars.PUBLIC_BASE_URL || origin,
    }),
    now: () => new Date(),
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
const bearer = (r: Request) =>
  r.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/)?.[1]
    .trim();
function internal(c: d.Ctx, r: Request) {
  const token = bearer(r);
  if (
    !c.config.internalApiToken ||
    !token ||
    !safeEqual(token, c.config.internalApiToken)
  )
    throw new AppError(401, "UNAUTHORIZED", "Unauthorized");
}
/** Shared D1 buckets survive isolate restarts. No process-local PIN/IP counters. */
async function limit(c: d.Ctx, key: string, max: number) {
  const now = Date.now(),
    expires = now + 60000;
  const row = await c.db.get<{ count: number }>(
    `INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<=? THEN 1 ELSE rate_limits.count+1 END,expires_at=CASE WHEN rate_limits.expires_at<=? THEN excluded.expires_at ELSE rate_limits.expires_at END RETURNING count`,
    [sha256(key), expires, now, now],
  );
  if (row!.count > max)
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many requests. Please wait a moment.",
    );
}
async function body(r: Request, max = 16384) {
  if (
    !r.headers.get("content-type")?.toLowerCase().startsWith("application/json")
  )
    throw new AppError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Expected application/json",
    );
  if (Number(r.headers.get("content-length") ?? 0) > max)
    throw new AppError(413, "TOO_LARGE", "Request too large");
  const reader = r.body?.getReader();
  let n = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    while (true) {
      const x = await reader.read();
      if (x.done) break;
      n += x.value.length;
      if (n > max) {
        await reader.cancel();
        throw new AppError(413, "TOO_LARGE", "Request too large");
      }
      chunks.push(x.value);
    }
  const buf = new Uint8Array(n);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return n ? JSON.parse(new TextDecoder().decode(buf)) : {};
  } catch {
    throw badRequest("INVALID_JSON", "Malformed JSON");
  }
}
const orderView = (o: any) => ({
  orderNumber: o.order_number,
  status: o.status,
  notes: o.notes,
  totalSatang: o.total_satang,
  createdAt: o.created_at,
  servedAt: o.served_at,
  items: o.items.map((i: any) => ({
    name: i.item_name_snapshot,
    quantity: i.quantity,
    unitPriceSatang: i.unit_price_satang,
    lineTotalSatang: i.line_total_satang,
    note: i.note,
  })),
});
const sessionView = (a: any) => ({
  code: a.session.session_code,
  status: a.session.status,
  isCurrent: a.isCurrent,
  tableNumber: a.table.display_number,
});
async function api(
  r: Request,
  env: Env,
  execution: ExecutionContext,
): Promise<Response> {
  const url = new URL(r.url),
    path = url.pathname,
    method = r.method === "HEAD" ? "GET" : r.method,
    c = context(env, url.origin);
  if (path === "/api/integrations/telegram/webhook") {
    if (method !== "POST")
      return json(
        {
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
        },
        405,
      );
    const expected = c.config.telegram.webhookSecret,
      got = r.headers.get("x-telegram-bot-api-secret-token");
    if (!expected)
      throw new AppError(503, "NOT_CONFIGURED", "Webhook not configured");
    if (!got || !safeEqual(got, expected))
      throw new AppError(401, "UNAUTHORIZED", "Unauthorized");
    const update = await body(r, 1024 * 1024);
    if (!Number.isSafeInteger(update?.update_id))
      throw badRequest("INVALID_UPDATE", "Invalid Telegram update");
    await c.db.transaction(async (tx) => {
      if (
        await tx.get(
          "SELECT update_id FROM telegram_updates WHERE update_id=?",
          [update.update_id],
        )
      )
        return;
      tx.run(
        "INSERT INTO telegram_inbox(update_id,payload,created_at,next_retry_at) VALUES (?,?,?,?) ON CONFLICT(update_id) DO NOTHING",
        [update.update_id, JSON.stringify(update), d.stamp(c), d.stamp(c)],
      );
    });
    execution.waitUntil(drain(c));
    return json({ ok: true });
  }
  if (path === "/healthz" && method === "GET") {
    const revision = await c.db.get<{ revision: number }>(
      "SELECT revision FROM app_revision WHERE id=1",
    );
    const pending = (await c.db.get<any>(
      "SELECT COUNT(*) AS c,MIN(created_at) AS oldest FROM outbox_events WHERE delivered_at IS NULL",
    ))!;
    return json({
      ok: !!revision,
      runtime: "cloudflare-workers",
      database: "d1",
      outboxPending: pending.c,
      outboxOldest: pending.oldest,
      menuReady: (await d.menuReadiness(c.db)).ready,
      telegramConfigured: !!(
        c.config.telegram.botToken &&
        c.config.telegram.staffChatId &&
        c.config.telegram.webhookSecret
      ),
    });
  }
  if (path.startsWith("/api/internal/")) {
    internal(c, r);
    if (path === "/api/internal/tables" && method === "GET")
      return json({ tables: await d.listTables(c.db) });
    if (path === "/api/internal/menu" && method === "GET")
      return json({ categories: await d.getMenu(c.db) });
    if (path === "/api/internal/configure" && method === "POST")
      return json(await d.provision(c, await body(r)));
    if (path === "/api/internal/receipt/generate" && method === "POST") {
      const b = await body(r),
        receipt = await c.db.get<any>(
          "SELECT * FROM receipts WHERE receipt_number=?",
          [typeof b.receiptNumber === "string" ? b.receiptNumber : ""],
        );
      if (!receipt) throw notFound("NOT_FOUND", "Receipt not found");
      const result = await generateReceipt(c, receipt.id, b.resend === true);
      execution.waitUntil(drain(c));
      return json({
        ok: true,
        receiptNumber: receipt.receipt_number,
        ...result,
      });
    }
    if (path === "/api/internal/outbox/drain" && method === "POST") {
      await body(r);
      await drain(c);
      return json({ ok: true });
    }
    throw notFound("NOT_FOUND", "Not found");
  }
  const ip = r.headers.get("cf-connecting-ip") || "local";
  const tableMatch = /^\/api\/public\/table\/([A-Za-z0-9_-]{1,128})$/.exec(
    path,
  );
  if (tableMatch && method === "GET") {
    await limit(c, `table:${ip}`, 60);
    return c.db.transaction(async () => {
      const t = await d.getTableByQrToken(c.db, tableMatch[1]);
      if (!t)
        throw notFound("TABLE_NOT_FOUND", "This QR code is not recognised.");
      const s = await d.getActiveSession(c.db, t);
      return json({
        venue: c.config.venue.name,
        table: { number: t.display_number, name: t.name },
        pinLength: c.config.access.pinLength,
        session: s ? { code: s.session_code, status: s.status } : null,
      });
    });
  }
  if (path === "/api/public/menu" && method === "GET") {
    await limit(c, `menu:${ip}`, 60);
    return c.db.transaction(async () =>
      json({
        orderingEnabled: (await d.menuReadiness(c.db)).ready,
        categories: (await d.getMenu(c.db)).map((cat) => ({
          code: cat.code,
          name: cat.name,
          items: cat.items.map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description,
            priceSatang: i.price_satang,
            imageUrl: i.image_url,
            thumbUrl: i.thumb_url,
            fullUrl: i.full_url,
            available: i.available === 1,
            ingredients: JSON.parse(i.ingredients),
          })),
        })),
      }),
    );
  }
  if (path === "/api/public/session/join" && method === "POST") {
    await limit(c, `join:${ip}`, 10);
    const b = await body(r);
    if (typeof b.qrToken !== "string" || typeof b.pin !== "string")
      throw badRequest("INVALID_REQUEST", "Please enter the PIN from staff.");
    return json(await d.joinSession(c, b.qrToken, b.pin.trim()));
  }
  const receiptMatch = /^\/api\/public\/receipt\/([A-Za-z0-9_-]{1,128})$/.exec(
    path,
  );
  if (receiptMatch && method === "GET") {
    await limit(c, `receipt:${ip}`, 30);
    if (!c.config.receipt.customerDownload)
      throw notFound("NOT_FOUND", "Not found");
    const receipt = await c.db.get<any>(
      "SELECT * FROM receipts WHERE lookup_token=?",
      [receiptMatch[1]],
    );
    if (!receipt) throw notFound("NOT_FOUND", "Receipt not found");
    const pdf = await readPdf(c, receipt.id);
    if (!pdf)
      throw new AppError(
        404,
        "RECEIPT_PENDING",
        "Your receipt is being prepared. Please try again shortly.",
      );
    return new Response(pdf, {
      headers: {
        "content-type": "application/pdf",
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename="${receipt.receipt_number}.pdf"`,
      },
    });
  }
  const customerRoutes: Record<string, string> = {
    "/api/public/orders": "POST",
    "/api/public/session/orders": "GET",
    "/api/public/session/bill": "GET",
    "/api/public/session/request-payment": "POST",
    "/api/public/session/status": "GET",
  };
  if (path in customerRoutes) {
    if (method !== customerRoutes[path])
      return json(
        {
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
        },
        405,
      );
    const mutating = method === "POST",
      bucket =
        path === "/api/public/orders"
          ? "order"
          : path.endsWith("request-payment")
            ? "pay"
            : "read",
      max = bucket === "order" ? 8 : bucket === "pay" ? 6 : 240;
    await limit(c, `${bucket}:ip:${ip}`, max * 4);
    const auth = await d.authenticate(c, bearer(r));
    await limit(c, `${bucket}:access:${auth.access.id}`, max);
    if (mutating) {
      d.requireCurrent(auth);
      const b = await body(r);
      if (bucket === "order") {
        const result = await d.placeOrder(c, auth, b);
        execution.waitUntil(drain(c));
        return json(
          {
            order: orderView({ ...result.order, items: result.items }),
            replayed: result.replayed,
          },
          result.replayed ? 200 : 201,
        );
      }
      const result = await d.requestPayment(c, auth, b);
      execution.waitUntil(drain(c));
      return json({ bill: result.bill }, result.created ? 201 : 200);
    }
    // Re-authenticate inside the consistent read so a concurrent payment never
    // returns a mixed OPEN session with a PAID bill, or the next guests' orders.
    return c.db.transaction(async () => {
      const a = await d.authenticate(c, bearer(r)),
        s = a.session,
        session = sessionView(a);
      if (path.endsWith("/orders"))
        return json({
          session,
          orders: (await d.sessionOrders(c.db, s.id)).map(orderView),
        });
      const bill = await d.currentBillView(c.db, c.config, s);
      if (path.endsWith("/bill")) return json({ session, bill });
      let payment = null,
        receipt = null;
      if (s.status === "PAID_CLOSED") {
        const p = await c.db.get<any>(
          "SELECT p.*,r.lookup_token,r.generated_at,r.receipt_number FROM payments p JOIN bills b ON b.id=p.bill_id LEFT JOIN receipts r ON r.payment_id=p.id WHERE b.session_id=?",
          [s.id],
        );
        if (p) {
          payment = {
            amountSatang: p.amount_satang,
            method: p.method,
            confirmedAt: p.confirmed_at,
          };
          if (c.config.receipt.customerDownload && p.lookup_token)
            receipt = {
              number: p.receipt_number,
              ready: !!p.generated_at,
              url: `/api/public/receipt/${p.lookup_token}`,
            };
        }
      }
      const cancelled =
        s.status === "OPEN" &&
        (await c.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM bills WHERE session_id=? AND status='CANCELLED'`,
          [s.id],
        ))!.n > 0;
      return json({
        session,
        orders: (await d.sessionOrders(c.db, s.id)).map(orderView),
        bill,
        billWasReopened: cancelled,
        payment,
        receipt,
        orderingEnabled:
          a.isCurrent &&
          s.status === "OPEN" &&
          (await d.menuReadiness(c.db)).ready,
      });
    });
  }
  if (path.startsWith("/api/")) throw notFound("NOT_FOUND", "Not found");
  if (!["GET", "HEAD"].includes(r.method))
    return json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
      405,
    );
  let asset = path;
  if (path === "/" || /^\/t\/[A-Za-z0-9_-]{1,128}$/.test(path))
    asset = "/index.html";
  else if (path.startsWith("/static/"))
    asset = decodeURIComponent(path.slice("/static".length));
  else throw notFound("NOT_FOUND", "Not found");
  if (asset.split("/").includes("..")) throw notFound("NOT_FOUND", "Not found");
  const assetUrl = new URL(asset, url.origin);
  const response = await env.ASSETS.fetch(new Request(assetUrl, r));
  const headers = new Headers(response.headers);
  headers.set(
    "cache-control",
    asset === "/index.html" ? "no-cache" : "public, max-age=300",
  );
  return new Response(response.body, { status: response.status, headers });
}
export default {
  async fetch(r: Request, env: Env, execution: ExecutionContext) {
    let response: Response;
    try {
      response = await api(r, env, execution);
    } catch (e) {
      if (e instanceof AppError)
        response = json(
          {
            error: {
              code: e.code,
              message: e.message,
              ...(e.details ? { details: e.details } : {}),
            },
          },
          e.status,
        );
      else {
        console.error("Worker request failed", redact(String(e)));
        response = json(
          {
            error: {
              code: "INTERNAL",
              message: "Something went wrong. Please try again.",
            },
          },
          500,
        );
      }
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(security))
      headers.set(key, value);
    return new Response(r.method === "HEAD" ? null : response.body, {
      status: response.status,
      headers,
    });
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    execution: ExecutionContext,
  ) {
    const c = context(env);
    execution.waitUntil(
      (async () => {
        await drain(c);
        await c.db.d1
          .prepare("DELETE FROM rate_limits WHERE expires_at<?")
          .bind(Date.now() - 3600000)
          .run();
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
