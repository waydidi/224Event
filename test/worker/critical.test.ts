import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { setup, INTERNAL, WEBHOOK } from "./helpers.ts";
import * as d from "../../src/cloudflare/domain.ts";
const order = (key: string, quantity = 1) => ({
  items: [{ menuItemId: 1, quantity, note: "less ice" }],
  idempotencyKey: key,
  expectedTotalSatang: 25000 * quantity,
});

test("Worker HTTP lifecycle: QR/PIN → order → served → frozen bill → cashier payment → thermal PDF → next round", async () => {
  const e = await setup({ charges: true });
  try {
    assert.equal((await e.api("/healthz")).data.runtime, "cloudflare-workers");
    assert.equal((await e.api("/api/internal/tables")).status, 401);
    assert.equal(
      (await e.api("/api/public/orders", order("unauthxx"))).status,
      401,
    );
    assert.equal(
      (await e.api("/api/integrations/telegram/webhook", { update_id: 1 }))
        .status,
      401,
    );
    await e.command("/open_table 1");
    assert.ok(
      e.calls.some(
        (x) => x.method === "sendMessage" && x.body.text.includes("TABLE1-1"),
      ),
    );
    const token = await e.join();
    const first = await e.api(
      "/api/public/orders",
      order("lifecycle001", 2),
      token,
    );
    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal(
      (await e.api("/api/public/orders", order("lifecycle001", 2), token))
        .status,
      200,
    );
    assert.equal(
      (await e.api("/api/public/orders", order("lifecycle001", 1), token))
        .status,
      409,
    );
    await e.flush();
    const serve = (await e.db
      .prepare("SELECT id FROM callback_actions WHERE action='order.serve'")
      .first<any>())!.id;
    await e.callback(serve, 9999);
    assert.equal(
      (await e.db.prepare("SELECT status FROM orders").first<any>())!.status,
      "NEW",
    );
    await e.callback(serve, 1001);
    assert.equal(
      (await e.db.prepare("SELECT status FROM orders").first<any>())!.status,
      "SERVED",
    );
    const bill = (await e.api("/api/public/session/bill", undefined, token))
      .data.bill;
    assert.equal(bill.totalSatang, 58850);
    const pay = await e.api(
      "/api/public/session/request-payment",
      { expectedTotalSatang: bill.totalSatang, expectedOrderCount: 1 },
      token,
    );
    assert.equal(pay.status, 201);
    assert.equal(
      (await e.api("/api/public/orders", order("paused001"), token)).data.error
        .code,
      "PAYMENT_REQUESTED",
    );
    const confirm = (await e.db
      .prepare(
        "SELECT id FROM callback_actions WHERE action='payment.confirm' LIMIT 1",
      )
      .first<any>())!.id;
    await e.callback(confirm, 1001);
    assert.equal(
      (await e.db.prepare("SELECT COUNT(*) AS n FROM payments").first<any>())!
        .n,
      0,
    );
    await e.callback(confirm);
    await e.callback(confirm);
    await e.flush();
    const status = (await e.api("/api/public/session/status", undefined, token))
      .data;
    assert.equal(status.session.status, "PAID_CLOSED");
    assert.equal(status.payment.amountSatang, 58850);
    assert.equal(status.receipt.ready, true);
    const response = await e.mf.dispatchFetch(
      `http://224.test${status.receipt.url}`,
    );
    assert.equal(response.status, 200);
    const pdf = new Uint8Array(await response.arrayBuffer());
    assert.equal(Buffer.from(pdf.subarray(0, 4)).toString(), "%PDF");
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getPageCount(), 1);
    assert.ok(Math.abs(doc.getPage(0).getWidth() - (80 * 72) / 25.4) < 0.01);
    assert.ok(doc.getPage(0).getHeight() > 400);
    assert.ok(e.calls.some((x) => x.method === "sendDocument"));
    fs.mkdirSync("/tmp/224-worker-qa", { recursive: true });
    fs.writeFileSync("/tmp/224-worker-qa/receipt-80mm.pdf", pdf);
    assert.equal(
      (await e.db.prepare("SELECT COUNT(*) AS n FROM payments").first<any>())!
        .n,
      1,
    );
    assert.equal(
      (await e.db.prepare("SELECT COUNT(*) AS n FROM receipts").first<any>())!
        .n,
      1,
    );
    await e.command("/open_table 1");
    const next = await e.join();
    assert.notEqual(next, token);
    assert.equal(
      (await e.api("/api/public/orders", order("oldround1"), token)).status,
      410,
    );
    assert.equal(
      (await e.api("/api/public/session/orders", undefined, next)).data.orders
        .length,
      0,
    );
    assert.equal(
      (await e.api("/api/public/session/status", undefined, token)).data.session
        .code,
      "TABLE1-1",
    );
  } finally {
    await e.close();
  }
});

test("D1 concurrency: duplicate keys, order/freeze race, confirm/reopen race, exactly one payment and receipt", async () => {
  const e = await setup();
  try {
    await e.command("/open_table 1");
    const token = await e.join(),
      auth = await d.authenticate(e.c, token);
    const dup = await Promise.all([
      d.placeOrder(e.c, auth, order("duplicate01")),
      d.placeOrder(e.c, auth, order("duplicate01")),
    ]);
    assert.equal(dup.filter((x) => !x.replayed).length, 1);
    assert.equal(dup[0].order.id, dup[1].order.id);
    const race = await Promise.allSettled([
      d.placeOrder(e.c, auth, order("racingorder")),
      d.requestPayment(e.c, auth, {
        expectedTotalSatang: 25000,
        expectedOrderCount: 1,
      }),
    ]);
    if (race[1].status === "rejected") {
      const bill = await d.currentBillView(
        e.c.db,
        e.c.config,
        (await d.getSession(e.c.db, auth.session.id))!,
      );
      await d.requestPayment(e.c, auth, {
        expectedTotalSatang: bill.totalSatang,
        expectedOrderCount: bill.orderNumbers.length,
      });
    }
    const frozen = (await e.db
      .prepare("SELECT * FROM bills WHERE status='REQUESTED'")
      .first<any>())!;
    const orderSum = (await e.db
      .prepare("SELECT SUM(total_satang) AS n FROM orders")
      .first<any>())!.n;
    assert.equal(frozen.total_satang, orderSum);
    const staff = (await d.findActiveStaff(e.c.db, 2002))!,
      actor = { type: "staff" as const, staff };
    const cr = await Promise.allSettled([
      d.confirmPayment(e.c, frozen.id, "Cash", actor),
      d.reopenBill(e.c, { billId: frozen.id }, actor),
    ]);
    const paid = (await e.db
      .prepare("SELECT COUNT(*) AS n FROM payments")
      .first<any>())!.n;
    if (!paid) {
      const view = await d.currentBillView(
        e.c.db,
        e.c.config,
        (await d.getSession(e.c.db, auth.session.id))!,
      );
      const fresh = await d.requestPayment(e.c, auth, {
        expectedTotalSatang: view.totalSatang,
        expectedOrderCount: view.orderNumbers.length,
      });
      await Promise.all([
        d.confirmPayment(e.c, fresh.bill.billId!, "Cash", actor),
        d.confirmPayment(e.c, fresh.bill.billId!, "PromptPay", actor),
      ]);
    }
    assert.equal(
      (await e.db.prepare("SELECT COUNT(*) AS n FROM payments").first<any>())!
        .n,
      1,
    );
    assert.equal(
      (await e.db.prepare("SELECT COUNT(*) AS n FROM receipts").first<any>())!
        .n,
      1,
    );
    assert.equal(
      (await e.db
        .prepare("SELECT current_session_id FROM tables WHERE id=1")
        .first<any>())!.current_session_id,
      null,
    );
    assert.ok(cr.some((r) => r.status === "fulfilled"));
  } finally {
    await e.close();
  }
});

test("D1 batch failure rolls back money, bill, session, receipt and outbox together", async () => {
  const e = await setup();
  try {
    await e.command("/open_table 1");
    const token = await e.join(),
      auth = await d.authenticate(e.c, token);
    await d.placeOrder(e.c, auth, order("rollback01"));
    const requested = await d.requestPayment(e.c, auth, {
      expectedTotalSatang: 25000,
      expectedOrderCount: 1,
    });
    const actor = {
      type: "staff" as const,
      staff: (await d.findActiveStaff(e.c.db, 2002))!,
    };
    await e.db
      .prepare(
        "CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected failure'); END",
      )
      .run();
    const before = (await e.db
      .prepare("SELECT COUNT(*) AS n FROM outbox_events")
      .first<any>())!.n;
    await assert.rejects(
      d.confirmPayment(e.c, requested.bill.billId!, "Cash", actor),
      /injected failure/,
    );
    assert.equal(
      (await e.db.prepare("SELECT COUNT(*) AS n FROM payments").first<any>())!
        .n,
      0,
    );
    assert.equal(
      (await e.db.prepare("SELECT status FROM bills").first<any>())!.status,
      "REQUESTED",
    );
    assert.equal(
      (await e.db.prepare("SELECT status FROM table_sessions").first<any>())!
        .status,
      "PAYMENT_REQUESTED",
    );
    assert.equal(
      (await e.db
        .prepare("SELECT COUNT(*) AS n FROM outbox_events")
        .first<any>())!.n,
      before,
    );
    await e.db.prepare("DROP TRIGGER fail_receipt").run();
    await d.confirmPayment(e.c, requested.bill.billId!, "Cash", actor);
  } finally {
    await e.close();
  }
});

test("PIN lockout, rotation, token expiry/revocation, staff revocation and wrong chat rejection", async () => {
  const e = await setup();
  try {
    await e.command("/open_table 1");
    const qr = e.tables[0].permanent_qr_token;
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await e.api("/api/public/session/join", { qrToken: qr, pin: "wrong" }))
          .status,
        401,
      );
    assert.equal(
      (await e.api("/api/public/session/join", { qrToken: qr, pin: "wrong" }))
        .status,
      423,
    );
    await e.command("/pin 1");
    const token = await e.join(),
      auth = await d.authenticate(e.c, token);
    const actor = {
      type: "staff" as const,
      staff: (await d.findActiveStaff(e.c.db, 2002))!,
    };
    await e.api(
      "/api/internal/configure",
      {
        operation: "staff",
        telegramUserId: "2002",
        name: "cashier",
        role: "cashier",
        active: false,
      },
      INTERNAL,
    );
    await assert.rejects(d.rotatePin(e.c, 1, actor), /Not authorized/);
    await e.callback("invalid_action_reference", 3003, 123);
    await e.c.db.transaction(async (tx) =>
      tx.run("UPDATE session_access SET revoked_at=? WHERE id=?", [
        new Date().toISOString(),
        auth.access.id,
      ]),
    );
    assert.equal(
      (await e.api("/api/public/session/status", undefined, token)).status,
      401,
    );
    await assert.rejects(
      d.placeOrder(e.c, auth, order("revoked001")),
      /join again/,
    );
    const next = await e.join();
    await e.c.db.transaction(async (tx) =>
      tx.run(
        "UPDATE session_access SET expires_at=? WHERE hashed_visit_token=?",
        [
          "2000-01-01T00:00:00.000Z",
          (await import("../../src/lib/ids.ts")).sha256(next),
        ],
      ),
    );
    assert.equal(
      (await e.api("/api/public/session/status", undefined, next)).data.error
        .code,
      "VISIT_TOKEN_EXPIRED",
    );
  } finally {
    await e.close();
  }
});

test("Telegram durable retry, inbox deduplication and 58mm receipt regeneration", async () => {
  const e = await setup({ width: 58 });
  try {
    e.setFailing(true);
    await e.command("/open_table 1");
    assert.ok(
      (await e.db
        .prepare(
          "SELECT COUNT(*) AS n FROM outbox_events WHERE delivered_at IS NULL AND attempts>0",
        )
        .first<any>())!.n > 0,
    );
    e.setFailing(false);
    await e.c.db.transaction(async (tx) =>
      tx.run(
        "UPDATE outbox_events SET next_retry_at='2000-01-01' WHERE delivered_at IS NULL",
      ),
    );
    await e.flush();
    assert.ok(
      e.calls.some(
        (x) => x.method === "sendMessage" && x.body.text.includes("TABLE1-1"),
      ),
    );
    const token = await e.join();
    await e.api("/api/public/orders", order("receipt58"), token);
    await e.api(
      "/api/public/session/request-payment",
      { expectedTotalSatang: 25000, expectedOrderCount: 1 },
      token,
    );
    const act = (await e.db
      .prepare(
        "SELECT id FROM callback_actions WHERE action='payment.confirm' LIMIT 1",
      )
      .first<any>())!.id;
    const update = {
      update_id: 99999,
      callback_query: {
        id: "repeat",
        from: { id: 2002 },
        message: { message_id: 100, chat: { id: -100777, type: "supergroup" } },
        data: `a:${act}`,
      },
    };
    await Promise.all([
      e.api("/api/integrations/telegram/webhook", update, undefined, {
        "x-telegram-bot-api-secret-token": WEBHOOK,
      }),
      e.api("/api/integrations/telegram/webhook", update, undefined, {
        "x-telegram-bot-api-secret-token": WEBHOOK,
      }),
    ]);
    await e.flush();
    const r = (await e.db.prepare("SELECT * FROM receipts").first<any>())!;
    const pdf = (await e.db
      .prepare("SELECT pdf FROM receipt_pdfs")
      .first<any>())!.pdf;
    const doc = await PDFDocument.load(new Uint8Array(pdf));
    assert.ok(Math.abs(doc.getPage(0).getWidth() - (58 * 72) / 25.4) < 0.01);
    fs.mkdirSync("/tmp/224-worker-qa", { recursive: true });
    fs.writeFileSync(
      "/tmp/224-worker-qa/receipt-58mm.pdf",
      new Uint8Array(pdf),
    );
    assert.equal(
      (
        await e.api(
          "/api/internal/receipt/generate",
          { receiptNumber: r.receipt_number },
          INTERNAL,
        )
      ).status,
      200,
    );
    assert.equal(
      (await e.db.prepare("SELECT COUNT(*) AS n FROM receipts").first<any>())!
        .n,
      1,
    );
    assert.equal(
      (await e.db
        .prepare(
          "SELECT COUNT(*) AS n FROM telegram_inbox WHERE update_id=99999",
        )
        .first<any>())!.n,
      1,
    );
  } finally {
    await e.close();
  }
});

test("staff operational commands: soldout/restock, reopen/fresh bill, empty close/void, legacy webhook dedupe and shared delivery lease", async () => {
  const e = await setup();
  try {
    await e.command("/open_table 1");
    const token = await e.join();
    await e.command("/soldout Lost Cherry");
    assert.equal(
      (await e.api("/api/public/orders", order("soldout01"), token)).data.error
        .code,
      "ITEM_UNAVAILABLE",
    );
    await e.command("/restock Lost Cherry");
    assert.equal(
      (await e.api("/api/public/orders", order("restock01"), token)).status,
      201,
    );
    await Promise.all([
      e.api("/api/internal/outbox/drain", {}, INTERNAL),
      e.api("/api/internal/outbox/drain", {}, INTERNAL),
      e.flush(),
    ]);
    assert.equal(
      e.calls.filter(
        (x) =>
          x.method === "sendMessage" &&
          x.body.text.includes("NEW COCKTAIL ORDER"),
      ).length,
      1,
    );
    await e.api(
      "/api/public/session/request-payment",
      { expectedTotalSatang: 25000, expectedOrderCount: 1 },
      token,
    );
    await e.command("/reopen_bill 1");
    assert.equal(
      (await e.api("/api/public/session/status", undefined, token)).data
        .billWasReopened,
      true,
    );
    await e.api("/api/public/orders", order("afteropen01"), token);
    const fresh = await e.api(
      "/api/public/session/request-payment",
      { expectedTotalSatang: 50000, expectedOrderCount: 2 },
      token,
    );
    assert.equal(fresh.data.bill.version, 2);
    await e.command("/close_table 1");
    assert.equal(
      (await e.db
        .prepare("SELECT status FROM table_sessions WHERE id=1")
        .first<any>())!.status,
      "PAYMENT_REQUESTED",
    );
    await e.command("/void_table 1 CONFIRM", 3003);
    assert.equal(
      (await e.db
        .prepare("SELECT status FROM table_sessions WHERE id=1")
        .first<any>())!.status,
      "VOIDED",
    );
    assert.equal(
      (await e.db.prepare("SELECT COUNT(*) AS n FROM orders").first<any>())!.n,
      2,
    );
    await e.command("/open_table 2");
    await e.command("/close_table 2");
    assert.equal(
      (await e.db
        .prepare("SELECT current_session_id FROM tables WHERE id=2")
        .first<any>())!.current_session_id,
      null,
    );
    await e.db
      .prepare(
        "INSERT INTO telegram_updates(update_id,received_at) VALUES (?,?)",
      )
      .bind(888888, new Date().toISOString())
      .run();
    await e.api(
      "/api/integrations/telegram/webhook",
      {
        update_id: 888888,
        message: {
          message_id: 1,
          chat: { id: -100777, type: "supergroup" },
          from: { id: 2002 },
          text: "/open_table 3",
        },
      },
      undefined,
      { "x-telegram-bot-api-secret-token": WEBHOOK },
    );
    await e.flush();
    assert.equal(
      (await e.db
        .prepare("SELECT current_session_id FROM tables WHERE id=3")
        .first<any>())!.current_session_id,
      null,
    );
  } finally {
    await e.close();
  }
});
