import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, CHAT } from "./helpers.ts";

const order = (idempotencyKey: string) => ({
  items: [{ menuItemId: 1, quantity: 1 }], idempotencyKey, expectedTotalSatang: 25000,
});

test("group full access: unregistered members operate tables, menu, orders, bills, payments and receipts", async () => {
  const e = await setup({ groupFullAccess: true });
  const user = 9999;
  try {
    await e.command("/whoami", user);
    const staff = await e.db.prepare("SELECT * FROM staff WHERE telegram_user_id=?").bind(String(user)).first<any>();
    assert.equal(staff.role, "lead");
    assert.equal(staff.active, 1);
    assert.ok(e.calls.some(x => x.body.text?.includes("Full staff access through this group")));
    await e.command("/open_table 1", user);
    const before = await e.db.prepare("SELECT * FROM table_sessions WHERE id=1").first<any>();
    assert.equal(before.opened_by, staff.id);
    await e.command("/pin 1", user);
    const token = await e.join();
    await e.command("/soldout Lost Cherry", user);
    assert.equal((await e.api("/api/public/orders", order("group-soldout"), token)).data.error.code, "ITEM_UNAVAILABLE");
    await e.command("/restock Lost Cherry", user);
    assert.equal((await e.api("/api/public/orders", order("group-order"), token)).status, 201);
    await e.flush();
    const action = async (kind: string) => (await e.db.prepare("SELECT id FROM callback_actions WHERE action=? ORDER BY rowid DESC LIMIT 1").bind(kind).first<any>())!.id;
    // An existing server also receives full access through membership.
    await e.callback(await action("order.serve"), 1001);
    assert.equal((await e.db.prepare("SELECT status FROM orders").first<any>())!.status, "SERVED");
    const request = () => e.api("/api/public/session/request-payment", { expectedTotalSatang: 25000, expectedOrderCount: 1 }, token);
    assert.equal((await request()).status, 201);
    await e.command("/reopen_bill 1", user);
    assert.equal((await e.api("/api/public/session/status", undefined, token)).data.billWasReopened, true);
    assert.equal((await request()).status, 201);
    const confirm = await action("payment.confirm");
    e.setMember(user, { status: "left", user: { id: user, is_bot: false } });
    await e.callback(confirm, user);
    assert.equal((await e.db.prepare("SELECT COUNT(*) AS n FROM payments").first<any>())!.n, 0);
    e.setMember(user, { status: "member", user: { id: user, is_bot: false } });
    await e.callback(confirm, user);
    await e.callback(confirm, 1001);
    assert.equal((await e.db.prepare("SELECT COUNT(*) AS n FROM payments").first<any>())!.n, 1);
    const status = (await e.api("/api/public/session/status", undefined, token)).data;
    assert.equal(status.session.status, "PAID_CLOSED");
    assert.equal(status.receipt.ready, true);
    assert.ok(e.calls.some(x => x.method === "sendDocument"));
    await e.command("/open_table 2", user);
    await e.command("/close_table 2", user);
    await e.command("/open_table 3", user);
    await e.command("/void_table 3 CONFIRM test", user);
    assert.equal((await e.db.prepare("SELECT status FROM table_sessions WHERE table_id=3").first<any>())!.status, "VOIDED");
    assert.ok((await e.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE actor_id=?").bind(`staff:${staff.id}`).first<any>())!.n > 5);
    assert.ok(e.calls.filter(x => x.method === "getChatMember").every(x => x.body.chat_id === CHAT));
  } finally { await e.close(); }
});

test("group access fails closed for removed members, bots, mismatched identities, API failures and other chats", async () => {
  const e = await setup({ groupFullAccess: true });
  try {
    await e.command("/open_table 1", 3003, 123);
    await e.command("/whoami", 9999, 123);
    assert.equal(e.calls.filter(x => x.method === "getChatMember").length, 0);
    assert.equal(await e.db.prepare("SELECT id FROM staff WHERE telegram_user_id='9999'").first(), null);
    const denied = [
      { status: "left", user: { id: 3003 } },
      { status: "kicked", user: { id: 3003 } },
      { status: "restricted", is_member: false, user: { id: 3003 } },
      { status: "member", user: { id: 3003, is_bot: true } },
      { status: "member", user: { id: 5555 } },
      { status: "unknown", user: { id: 3003 } },
      "error",
    ];
    for (const member of denied) {
      e.setMember(3003, member);
      await e.command("/open_table 1", 3003);
      assert.equal((await e.db.prepare("SELECT COUNT(*) AS n FROM table_sessions").first<any>())!.n, 0);
    }
    // A bot sender is rejected before any lookup, even if the API would return a human.
    const count = e.calls.filter(x => x.method === "getChatMember").length;
    await e.webhook({ message: { message_id: 300, chat: { id: Number(CHAT), type: "group" }, from: { id: 3003, is_bot: true }, text: "/open_table 1" } });
    await e.flush();
    assert.equal(e.calls.filter(x => x.method === "getChatMember").length, count);
    for (const [user, member] of [
      [8881, { status: "creator", user: { id: 8881 } }],
      [8882, { status: "administrator", user: { id: 8882 } }],
      [8883, { status: "restricted", is_member: true, user: { id: 8883 } }],
    ] as const) {
      e.setMember(user, member);
      await e.command("/whoami", user);
      assert.equal((await e.db.prepare("SELECT role FROM staff WHERE telegram_user_id=?").bind(String(user)).first<any>())!.role, "lead");
    }
  } finally { await e.close(); }
});
