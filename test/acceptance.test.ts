import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { receiptText, receiptItems } from '../src/receipts/pdf.ts';
import { loadReceiptData } from '../src/receipts/model.ts';
import { auth, command, http, join, menuId, openTable, order, setup, tap, USERS, webhook, type TestEnv } from './helpers.ts';

describe('224 Live House acceptance (spec §13)', () => {
  let env: TestEnv;
  let pin: string;
  let tokenA: string;
  let tokenB: string;
  let order1: any;
  let order2: any;

  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env.close();
  });

  test('1. QR for Table 1 resolves to Table 1 with no session before staff opens it', async () => {
    const r = await http(env, 'GET', `/api/public/table/${env.qr(1)}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.table.number, 1);
    assert.equal(r.data.session, null);
    assert.equal((await http(env, 'GET', '/api/public/table/not-a-real-token')).status, 404);
  });

  test('2. Staff opens first session; system assigns TABLE1-1 and posts the PIN', async () => {
    const s = await openTable(env, 1);
    assert.equal(s.session_code, 'TABLE1-1');
    assert.match(s.join_pin, /^\d{6}$/);
    pin = s.join_pin;
    assert.ok(env.tg.sent((t) => t.includes('TABLE 1 OPENED') && t.includes(pin)).length === 1);
    const r = await http(env, 'GET', `/api/public/table/${env.qr(1)}`);
    assert.equal(r.data.session.code, 'TABLE1-1');
    // Opening again is rejected (only one active session per table).
    await command(env, USERS.cashier, '/open_table 1');
    assert.ok(env.tg.sent((t) => t.includes('already has active session TABLE1-1')).length === 1);
  });

  test('QR alone is not enough: wrong PIN is rejected', async () => {
    const r = await http(env, 'POST', '/api/public/session/join', { qrToken: env.qr(1), pin: '000000' === pin ? '111111' : '000000' });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'INVALID_PIN');
    const noToken = await http(env, 'POST', '/api/public/orders', { items: [], idempotencyKey: 'abcdefgh' });
    assert.equal(noToken.status, 401);
  });

  test('3. Customer submits an order; stored exactly once; staff group gets items and total', async () => {
    tokenA = await join(env, 1, pin);
    const body = {
      items: [{ menuItemId: await menuId(env, 'lost-cherry'), quantity: 2 }, { menuItemId: await menuId(env, 'negroni'), quantity: 1 }],
      notes: 'Less ice',
      idempotencyKey: 'order-key-0001',
      expectedTotalSatang: 78000,
    };
    const r = await http(env, 'POST', '/api/public/orders', body, auth(tokenA));
    assert.equal(r.status, 201);
    order1 = r.data.order;
    assert.equal(order1.totalSatang, 78000);
    assert.equal(order1.status, 'NEW');
    // Retry with the same idempotency key (e.g. flaky network) returns the same order.
    const again = await http(env, 'POST', '/api/public/orders', body, auth(tokenA));
    assert.equal(again.status, 200);
    assert.equal(again.data.replayed, true);
    assert.equal(again.data.order.orderNumber, order1.orderNumber);
    // Same key, different contents → rejected.
    const tampered = await http(env, 'POST', '/api/public/orders', { ...body, notes: 'x' }, auth(tokenA));
    assert.equal(tampered.status, 409);
    await env.drain();
    const count = env.app.ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM orders')!.c;
    assert.equal(count, 1);
    const cards = env.tg.sent((t) => t.includes('NEW COCKTAIL ORDER'));
    assert.equal(cards.length, 1);
    const text = cards[0].params.text as string;
    assert.match(text, /Session: TABLE1-1/);
    assert.match(text, /2 × Lost Cherry\s+฿560/);
    assert.match(text, /1 × Negroni\s+฿220/);
    assert.match(text, /ORDER TOTAL\s+฿780/);
    assert.match(text, /Less ice/);
    assert.match(cards[0].params.reply_markup.inline_keyboard[0][0].text, /Mark as Served/);
    // Callback data is an opaque reference, not state.
    assert.match(cards[0].params.reply_markup.inline_keyboard[0][0].callback_data, /^a:[A-Za-z0-9_-]{20}$/);
  });

  test('client-submitted prices/totals are never trusted', async () => {
    const r = await order(env, tokenA, [['mojito', 1]], { expectedTotalSatang: 100 });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'PRICE_CHANGED');
    const bad = await order(env, tokenA, [['mojito', 0]]);
    assert.equal(bad.status, 400);
  });

  test('4. Two customers in the same session order separately; both appear in one bill', async () => {
    tokenB = await join(env, 1, pin);
    const r = await order(env, tokenB, [['mojito', 2]]);
    assert.equal(r.status, 201);
    order2 = r.data.order;
    const bill = await http(env, 'GET', '/api/public/session/bill', undefined, auth(tokenA));
    assert.equal(bill.data.bill.status, 'DRAFT');
    assert.deepEqual(bill.data.bill.orderNumbers, [order1.orderNumber, order2.orderNumber]);
    assert.equal(bill.data.bill.totalSatang, 122000);
  });

  test('5+6. Served: authorized staff tap updates customer + card exactly once; repeats are no-ops', async () => {
    const card = env.tg.sent((t) => t.includes(order1.orderNumber) && t.includes('NEW COCKTAIL ORDER'))[0];
    const data = card.params.reply_markup.inline_keyboard[0][0].callback_data;

    // Stranger cannot mark served.
    await tap(env, USERS.stranger, data);
    assert.match(env.tg.answers().at(-1)!, /Not authorized/);

    await tap(env, USERS.server, data);
    assert.match(env.tg.answers().at(-1)!, /marked as served/);
    await tap(env, USERS.server, data);
    await tap(env, USERS.cashier, data);
    assert.match(env.tg.answers().at(-1)!, /already served/);

    const edits = env.tg.edits((t) => t.includes('ORDER SERVED') && t.includes(order1.orderNumber));
    assert.equal(edits.length, 1);
    assert.equal(edits[0].params.message_id, card.params.message_id ?? edits[0].params.message_id);
    assert.match(edits[0].params.text, /Served by: Mali \(server\)/);
    assert.deepEqual(edits[0].params.reply_markup.inline_keyboard, []);
    const audits = env.app.ctx.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM audit_events WHERE action = 'order.served'")!.c;
    assert.equal(audits, 1);

    const st = await http(env, 'GET', '/api/public/session/status', undefined, auth(tokenB));
    const o = st.data.orders.find((x: any) => x.orderNumber === order1.orderNumber);
    assert.equal(o.status, 'SERVED');
  });

  test('7. Pay Table shows the full itemized current total before requesting payment', async () => {
    const st = await http(env, 'GET', '/api/public/session/status', undefined, auth(tokenA));
    const bill = st.data.bill;
    assert.equal(bill.status, 'DRAFT');
    assert.deepEqual(
      bill.lines.map((l: any) => [l.orderNumber, l.itemName, l.quantity, l.unitPriceSatang, l.lineTotalSatang]),
      [
        [order1.orderNumber, 'Lost Cherry', 2, 28000, 56000],
        [order1.orderNumber, 'Negroni', 1, 22000, 22000],
        [order2.orderNumber, 'Mojito', 2, 22000, 44000],
      ],
    );
    assert.equal(bill.subtotalSatang, 122000);
    assert.deepEqual(bill.adjustments, []); // none configured → none invented
    assert.equal(bill.totalSatang, 122000);
    assert.equal(st.data.session.status, 'OPEN');
  });

  test('stale review: request is rejected if the bill changed after the customer reviewed it', async () => {
    const r = await http(env, 'POST', '/api/public/session/request-payment', { expectedTotalSatang: 56000, expectedOrderCount: 1 }, auth(tokenA));
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'BILL_CHANGED');
  });

  test('8. Confirm payment request: Telegram gets the bill; new orders are frozen', async () => {
    const r = await http(env, 'POST', '/api/public/session/request-payment', { expectedTotalSatang: 122000, expectedOrderCount: 2 }, auth(tokenA));
    assert.equal(r.status, 201);
    assert.equal(r.data.bill.status, 'REQUESTED');
    // Second guest's double-tap is idempotent.
    const again = await http(env, 'POST', '/api/public/session/request-payment', { expectedTotalSatang: 122000, expectedOrderCount: 2 }, auth(tokenB));
    assert.equal(again.status, 200);
    assert.equal(again.data.bill.billNumber, r.data.bill.billNumber);
    await env.drain();
    const cards = env.tg.sent((t) => t.includes('PAYMENT REQUESTED'));
    assert.equal(cards.length, 1);
    assert.match(cards[0].params.text, /TOTAL TO COLLECT: <b>฿1,220<\/b>/);
    assert.match(cards[0].params.text, new RegExp(`Orders: ${order1.orderNumber}, ${order2.orderNumber}`));
    const blocked = await order(env, tokenB, [['negroni', 1]]);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error.code, 'PAYMENT_REQUESTED');
    const st = await http(env, 'GET', '/api/public/session/status', undefined, auth(tokenA));
    assert.equal(st.data.session.status, 'PAYMENT_REQUESTED');
    assert.equal(st.data.orderingEnabled, false);
  });

  test('reopen: cashier can reopen a pending bill so guests add drinks; a fresh bill is issued', async () => {
    const reopen = env.tg.button(/Reopen bill/, 'sent');
    await tap(env, USERS.server, reopen);
    assert.match(env.tg.answers().at(-1)!, /Not authorized/);
    await tap(env, USERS.cashier, reopen);
    assert.match(env.tg.answers().at(-1)!, /cancelled/);
    assert.equal(env.tg.edits((t) => t.includes('BILL REOPENED')).length, 1);

    const extra = await order(env, tokenB, [['negroni', 1]]);
    assert.equal(extra.status, 201);
    const st = await http(env, 'GET', '/api/public/session/status', undefined, auth(tokenA));
    assert.equal(st.data.bill.totalSatang, 144000);
    const r = await http(env, 'POST', '/api/public/session/request-payment', { expectedTotalSatang: 144000, expectedOrderCount: 3 }, auth(tokenA));
    assert.equal(r.status, 201);
    assert.equal(r.data.bill.version, 2);
    await env.drain();
    // Old bill's buttons no longer work.
    await tap(env, USERS.cashier, reopen);
    assert.match(env.tg.answers().at(-1)!, /already reopened/);
  });

  test('9+10. Only an authorized cashier can confirm paid; repeated taps create one payment and one closed session', async () => {
    const card = env.tg.sent((t) => t.includes('PAYMENT REQUESTED') && t.includes('฿1,440'))[0];
    const cash = card.params.reply_markup.inline_keyboard.flat().find((b: any) => /Confirm Paid · Cash/.test(b.text)).callback_data;
    const promptpay = card.params.reply_markup.inline_keyboard.flat().find((b: any) => /PromptPay/.test(b.text)).callback_data;

    await tap(env, USERS.stranger, cash);
    assert.match(env.tg.answers().at(-1)!, /Not authorized/);
    await tap(env, USERS.server, cash);
    assert.match(env.tg.answers().at(-1)!, /Not authorized/);
    // Even an authorized user tapping from another chat is refused.
    await tap(env, USERS.cashier, cash, '-1009999');
    assert.match(env.tg.answers().at(-1)!, /only available in the staff group/);
    assert.equal(env.app.ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM payments')!.c, 0);

    await tap(env, USERS.cashier, cash);
    assert.match(env.tg.answers().at(-1)!, /Payment of ฿1,440 recorded/);
    await tap(env, USERS.cashier, cash);
    await tap(env, USERS.lead, promptpay);
    assert.match(env.tg.answers().at(-1)!, /already paid/);

    const db = env.app.ctx.db;
    assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM payments')!.c, 1);
    const p = db.get<any>('SELECT * FROM payments')!;
    assert.equal(p.amount_satang, 144000);
    assert.equal(p.method, 'Cash');
    const s = db.get<any>("SELECT * FROM table_sessions WHERE session_code = 'TABLE1-1'")!;
    assert.equal(s.status, 'PAID_CLOSED');
    assert.equal(db.get<any>('SELECT * FROM tables WHERE display_number = 1')!.status, 'AVAILABLE');

    const paidCard = env.tg.edits((t) => t.includes('PAYMENT CONFIRMED'));
    assert.equal(paidCard.length, 1);
    assert.match(paidCard[0].params.text, /Total received: <b>฿1,440<\/b>/);
    assert.match(paidCard[0].params.text, /Confirmed by: Somchai \(cashier\)/);
    assert.match(paidCard[0].params.text, /Next session: TABLE1-2 \(awaiting activation\)/);

    const st = await http(env, 'GET', '/api/public/session/status', undefined, auth(tokenA));
    assert.equal(st.data.session.status, 'PAID_CLOSED');
    assert.equal(st.data.payment.amountSatang, 144000);
    assert.equal(st.data.receipt.ready, true);
  });

  test('11. Receipt PDF totals exactly match the frozen bill and include every order line', async () => {
    const db = env.app.ctx.db;
    const receipt = db.get<any>('SELECT * FROM receipts')!;
    assert.equal(receipt.receipt_number, 'R-000001');
    assert.ok(receipt.pdf_storage_key);
    const data = loadReceiptData(db, env.config, receipt);
    const bill = db.get<any>("SELECT * FROM bills WHERE status = 'PAID'")!;
    assert.equal(data.totalSatang, bill.total_satang);
    assert.equal(data.lines.reduce((s, l) => s + l.lineTotalSatang, 0), bill.subtotal_satang);
    const allItems = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN table_sessions s ON s.id = o.session_id WHERE s.session_code = ?', ['TABLE1-1'])!.c;
    assert.equal(data.lines.length, allItems);

    // Identical items across orders print as one line; amounts still add up exactly.
    assert.deepEqual(receiptItems(data).map((i) => [i.name, i.quantity, i.lineTotalSatang]), [['Lost Cherry', 2, 56000], ['Negroni', 2, 44000], ['Mojito', 2, 44000]]);
    assert.equal(receiptItems(data).reduce((s, i) => s + i.lineTotalSatang, 0), bill.subtotal_satang);
    const text = receiptText(data);
    assert.match(text, /224 LIVE HOUSE/);
    assert.match(text, /SALES RECEIPT/);
    assert.doesNotMatch(text, /TAX INVOICE/i);
    assert.match(text, /Table: TABLE1-1/);
    assert.match(text, /Receipt: R-000001/);
    assert.match(text, /Lost Cherry\n2 × ฿280\.00 560\.00/);
    assert.match(text, /Negroni\n2 × ฿220\.00 440\.00/);
    assert.match(text, /Mojito\n2 × ฿220\.00 440\.00/);
    assert.match(text, /TOTAL ฿1,440\.00/);
    assert.match(text, /Payment Cash/);
    assert.match(text, /Status PAID/);
    assert.match(text, /THANK YOU!/);

    // PDF was sent to the staff group exactly once, and is downloadable by the guest.
    assert.equal(env.tg.documents.length, 1);
    assert.equal(env.tg.documents[0].filename, 'R-000001.pdf');
    assert.equal(env.tg.documents[0].data.subarray(0, 5).toString(), '%PDF-');
    const st = await http(env, 'GET', '/api/public/session/status', undefined, auth(tokenA));
    const pdf = await http(env, 'GET', st.data.receipt.url);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');

    // Regeneration is safe: no new payment, no new receipt, no resend.
    const regen = await http(env, 'POST', '/api/internal/receipt/generate', { receiptNumber: 'R-000001' }, auth('internal-test-token'));
    assert.equal(regen.status, 200);
    await env.drain();
    assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM payments')!.c, 1);
    assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM receipts')!.c, 1);
    assert.equal(env.tg.documents.length, 1);
    assert.equal((await http(env, 'POST', '/api/internal/receipt/generate', { receiptNumber: 'R-000001' })).status, 401);
  });

  test('12+13. Same QR works for TABLE1-2; prior session immutable; old token cannot order or see TABLE1-2', async () => {
    const r1 = await http(env, 'GET', `/api/public/table/${env.qr(1)}`);
    assert.equal(r1.data.table.number, 1);
    assert.equal(r1.data.session, null);

    await tap(env, USERS.cashier, env.tg.button(/Open TABLE1-2/));
    const s2 = env.app.ctx.db.get<any>("SELECT * FROM table_sessions WHERE session_code = 'TABLE1-2'")!;
    assert.equal(s2.status, 'OPEN');
    assert.notEqual(s2.join_pin, undefined);
    const r2 = await http(env, 'GET', `/api/public/table/${env.qr(1)}`);
    assert.equal(r2.data.session.code, 'TABLE1-2');

    // Old browser token: still bound to TABLE1-1.
    const stale = await order(env, tokenA, [['negroni', 1]]);
    assert.equal(stale.status, 410);
    assert.equal(stale.data.error.code, 'SESSION_ENDED');
    const st = await http(env, 'GET', '/api/public/session/status', undefined, auth(tokenA));
    assert.equal(st.data.session.code, 'TABLE1-1');
    assert.equal(st.data.session.isCurrent, false);
    const bill = await http(env, 'GET', '/api/public/session/bill', undefined, auth(tokenA));
    assert.equal(bill.data.bill.sessionCode, 'TABLE1-1');
    const pay = await http(env, 'POST', '/api/public/session/request-payment', { expectedTotalSatang: 0, expectedOrderCount: 0 }, auth(tokenA));
    assert.equal(pay.status, 410);
    // Old PIN does not admit anyone to the new round (unless it collides by chance).
    if (pin !== s2.join_pin) assert.equal((await http(env, 'POST', '/api/public/session/join', { qrToken: env.qr(1), pin })).status, 401);

    // New group joins and orders in TABLE1-2; old session's bill is unchanged.
    const tokenC = await join(env, 1, s2.join_pin);
    assert.equal((await order(env, tokenC, [['martini', 1]])).status, 201);
    const oldBill = await http(env, 'GET', '/api/public/session/bill', undefined, auth(tokenA));
    assert.equal(oldBill.data.bill.totalSatang, 144000);
    const newBill = await http(env, 'GET', '/api/public/session/bill', undefined, auth(tokenC));
    assert.equal(newBill.data.bill.sessionCode, 'TABLE1-2');
    assert.equal(newBill.data.bill.lines.length, 1);

    // Financial records are immutable at the database level.
    const db = env.app.ctx.db;
    assert.throws(() => db.run('UPDATE payments SET amount_satang = 1'), /immutable/);
    assert.throws(() => db.run('UPDATE order_items SET quantity = 9'), /immutable/);
    assert.throws(() => db.run('DELETE FROM audit_events'), /append-only/);
    // And the served button on a closed session's card cannot mutate it.
    const s1orders = db.all<any>("SELECT o.* FROM orders o JOIN table_sessions s ON s.id = o.session_id WHERE s.session_code = 'TABLE1-1' AND o.status = 'NEW'");
    if (s1orders.length) {
      await tap(env, USERS.server, `a:${s1orders[0].serve_action_id}`);
      assert.match(env.tg.answers().at(-1)!, /closed/);
    }
  });

  test('round numbers are unique per table and increment', () => {
    const rounds = env.app.ctx.db.all<any>('SELECT round_number FROM table_sessions s JOIN tables t ON t.id = s.table_id WHERE t.display_number = 1 ORDER BY round_number');
    assert.deepEqual(rounds.map((r) => r.round_number), [1, 2]);
  });

  test('webhook rejects requests without the secret token', async () => {
    const r = await webhook(env, { message: { text: '/open_table 2', chat: { id: -100777 }, from: { id: USERS.lead } } }, 'wrong');
    assert.equal(r.status, 401);
    const t2 = await http(env, 'GET', `/api/public/table/${env.qr(2)}`);
    assert.equal(t2.data.session, null);
  });
});
