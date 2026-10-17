import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { applyBps, formatAmount, formatBaht, parseBaht } from '../src/lib/money.ts';
import { row } from '../src/telegram/render.ts';
import { auth, command, http, join, openTable, order, setup, tap, USERS, type TestEnv } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe('reliability & security', () => {
  test('14. Telegram outage does not lose orders; queued notifications retry and deliver once', async () => {
    env = await setup();
    const s = await openTable(env, 1);
    const token = await join(env, 1, s.join_pin);
    env.tg.failing = true;
    const r = await order(env, token, [['negroni', 1]]);
    assert.equal(r.status, 201, 'order accepted while Telegram is down');
    const pending = env.app.ctx.db.get<any>("SELECT * FROM outbox_events WHERE event_type = 'telegram.order_card'")!;
    assert.equal(pending.delivered_at, null);
    assert.ok(pending.attempts >= 1);
    assert.match(pending.last_error, /502/);
    assert.doesNotMatch(pending.last_error, /123456:TEST/);

    // Still down after the first backoff.
    env.advance(3_000);
    await env.drain();
    assert.equal(env.tg.sent((t) => t.includes('NEW COCKTAIL ORDER')).length, 0);

    env.tg.failing = false;
    env.advance(10 * 60_000);
    await env.drain();
    assert.equal(env.tg.sent((t) => t.includes('NEW COCKTAIL ORDER')).length, 1);
    env.advance(10 * 60_000);
    await env.drain();
    assert.equal(env.tg.sent((t) => t.includes('NEW COCKTAIL ORDER')).length, 1, 'no duplicates after delivery');
    assert.equal(env.app.ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM orders')!.c, 1);
  });

  test('receipt delivery failure is retried without a second payment', async () => {
    env = await setup();
    const s = await openTable(env, 1);
    const token = await join(env, 1, s.join_pin);
    await order(env, token, [['mojito', 1]]);
    await http(env, 'POST', '/api/public/session/request-payment', { expectedTotalSatang: 22000, expectedOrderCount: 1 }, auth(token));
    await env.drain();
    const pay = env.tg.button(/Confirm Paid · Cash/);
    env.tg.failing = true;
    await tap(env, USERS.cashier, pay);
    assert.equal(env.app.ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM payments')!.c, 1);
    assert.equal(env.tg.documents.length, 0);
    env.tg.failing = false;
    env.advance(10 * 60_000);
    await env.drain();
    await tap(env, USERS.cashier, pay);
    env.advance(10 * 60_000);
    await env.drain();
    assert.equal(env.tg.documents.length, 1);
    assert.equal(env.app.ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM payments')!.c, 1);
  });

  test('16. No order is accepted until every cocktail (18 + 3 birthday specials) has a configured price', async () => {
    env = await setup({ prices: false });
    assert.equal(env.app.ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM menu_items')!.c, 21);
    const menu = await http(env, 'GET', '/api/public/menu');
    assert.equal(menu.data.orderingEnabled, false);
    assert.deepEqual(menu.data.categories.map((c: any) => [c.name, c.items.length]), [['Ken’s birthday Special', 3], ['Signature Cocktails', 6], ['Classic Cocktails', 12]]);
    const negroni = menu.data.categories[2].items.find((i: any) => i.name === 'Negroni');
    assert.deepEqual(negroni.ingredients, ['Gin', 'Campari', 'Sweet vermouth', 'Orange peel']);
    assert.deepEqual(menu.data.categories[1].items[0].ingredients, []); // signature recipes come from the bar
    const s = await openTable(env, 1);
    const token = await join(env, 1, s.join_pin);
    // Price all but one.
    const items = env.app.ctx.db.all<{ id: number }>('SELECT id FROM menu_items ORDER BY id');
    for (const it of items.slice(1)) env.app.ctx.db.run('UPDATE menu_items SET price_satang = 20000 WHERE id = ?', [it.id]);
    const r = await order(env, token, [['negroni', 1]]);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'MENU_NOT_READY');
    env.app.ctx.db.run('UPDATE menu_items SET price_satang = 20000 WHERE id = ?', [items[0].id]);
    assert.equal((await order(env, token, [['negroni', 1]])).status, 201);
  });

  test('PIN brute force locks the session until staff issues a new PIN', async () => {
    env = await setup({ env: { PIN_MAX_FAILED_ATTEMPTS: '3' } });
    const s = await openTable(env, 1);
    const wrong = s.join_pin === '12' ? '21' : '12';
    for (let i = 0; i < 3; i++) assert.equal((await http(env, 'POST', '/api/public/session/join', { qrToken: env.qr(1), pin: wrong })).status, 401);
    const locked = await http(env, 'POST', '/api/public/session/join', { qrToken: env.qr(1), pin: s.join_pin });
    assert.equal(locked.status, 423);
    await command(env, USERS.server, '/pin 1');
    assert.match(env.tg.sent().at(-1)!.params.text, /Not authorized/);
    await command(env, USERS.cashier, '/pin 1');
    const fresh = env.app.ctx.db.get<any>('SELECT * FROM table_sessions WHERE id = ?', [s.id])!;
    assert.equal(fresh.pin_failed_attempts, 0);
    assert.ok(await join(env, 1, fresh.join_pin));
  });

  test('visit tokens expire', async () => {
    env = await setup();
    const s = await openTable(env, 1);
    const token = await join(env, 1, s.join_pin);
    env.advance(13 * 3600_000);
    const r = await http(env, 'GET', '/api/public/session/status', undefined, auth(token));
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'VISIT_TOKEN_EXPIRED');
  });

  test('close/void: empty sessions close; sessions with orders need a lead and CONFIRM; paid history untouched', async () => {
    env = await setup();
    await openTable(env, 2);
    await command(env, USERS.cashier, '/close_table 2');
    assert.match(env.tg.sent().at(-1)!.params.text, /TABLE2-1 closed/);

    const s = await openTable(env, 2);
    assert.equal(s.session_code, 'TABLE2-2');
    const token = await join(env, 2, s.join_pin);
    await order(env, token, [['negroni', 1]]);
    await command(env, USERS.cashier, '/close_table 2');
    assert.match(env.tg.sent().at(-1)!.params.text, /has 1 order/);
    await command(env, USERS.cashier, '/void_table 2 CONFIRM');
    assert.match(env.tg.sent().at(-1)!.params.text, /needs a lead/);
    await command(env, USERS.lead, '/void_table 2');
    assert.match(env.tg.sent().at(-1)!.params.text, /CONFIRM/);
    await command(env, USERS.lead, '/void_table 2 CONFIRM walk-out');
    assert.match(env.tg.sent().at(-1)!.params.text, /TABLE2-2 VOIDED/);
    const st = await http(env, 'GET', '/api/public/session/status', undefined, auth(token));
    assert.equal(st.data.session.status, 'VOIDED');
    assert.equal((await order(env, token, [['negroni', 1]])).status, 410);
    const a = env.app.ctx.db.get<any>("SELECT * FROM audit_events WHERE action = 'session.void'")!;
    assert.match(a.metadata, /walk-out/);
  });

  test('sold out items cannot be ordered; staff toggle via Telegram', async () => {
    env = await setup();
    const s = await openTable(env, 1);
    const token = await join(env, 1, s.join_pin);
    await command(env, USERS.cashier, '/soldout Espresso Martini');
    const r = await order(env, token, [['espresso-martini', 1]]);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'ITEM_UNAVAILABLE');
    await command(env, USERS.cashier, '/restock espresso');
    assert.equal((await order(env, token, [['espresso-martini', 1]])).status, 201);
  });

  test('duplicate Telegram update deliveries are processed once', async () => {
    env = await setup();
    const update = { update_id: 4242, message: { message_id: 1, chat: { id: -100777, type: 'supergroup' }, from: { id: USERS.cashier }, text: '/open_table 3' } };
    for (let i = 0; i < 2; i++) {
      await http(env, 'POST', '/api/integrations/telegram/webhook', update, { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' });
      await env.drain();
    }
    assert.equal(env.tg.sent((t) => t.includes('already has active session')).length, 0);
    assert.equal(env.tg.sent((t) => t.includes('TABLE 3 OPENED')).length, 1);
  });

  test('configured service charge/VAT are applied and shown; none are invented otherwise', async () => {
    env = await setup({ env: { SERVICE_CHARGE_BPS: '1000', VAT_BPS: '700' } });
    const s = await openTable(env, 1);
    const token = await join(env, 1, s.join_pin);
    await order(env, token, [['negroni', 1]]); // 220.00
    const b = (await http(env, 'GET', '/api/public/session/bill', undefined, auth(token))).data.bill;
    assert.deepEqual(b.adjustments.map((a: any) => [a.label, a.amountSatang]), [['Service charge 10%', 2200], ['VAT 7%', 1694]]);
    assert.equal(b.totalSatang, 22000 + 2200 + 1694);
  });

  test('frontend shell and assets are served with security headers', async () => {
    env = await setup();
    const page = await http(env, 'GET', `/t/${env.qr(1)}`);
    assert.equal(page.status, 200);
    assert.match(page.data.toString(), /<main id="app"/);
    assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await http(env, 'GET', '/static/app.js')).status, 200);
    assert.equal((await http(env, 'GET', '/static/..%2f..%2fpackage.json')).status, 404);
    const health = await http(env, 'GET', '/healthz');
    assert.equal(health.data.ok, true);
  });
});

describe('formatting', () => {
  test('money', () => {
    assert.equal(formatBaht(122000), '฿1,220');
    assert.equal(formatBaht(12050), '฿120.50');
    assert.equal(formatAmount(122000), '1,220.00');
    assert.equal(parseBaht('280'), 28000);
    assert.equal(parseBaht('280.5'), 28050);
    assert.throws(() => parseBaht('-1'));
    assert.equal(applyBps(22000, 1000), 2200);
    assert.equal(applyBps(24200, 700), 1694);
  });

  test('telegram rows are aligned and wrap long names', () => {
    assert.deepEqual(row('2 × Lost Cherry', '฿560'), ['2 × Lost Cherry           ฿560']);
    const long = row('3 × Long Island Iced Tea Special Edition', '฿1,320');
    assert.ok(long.length > 1);
    assert.ok(long[0].endsWith('฿1,320'));
  });
});
