import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { applyBps, formatAmount, formatBaht, parseBaht } from '../src/lib/money.ts';
import { row } from '../src/telegram/render.ts';
import { auth, command, http, join, menuId, openTable, order, setup, tap, USERS, type TestEnv } from './helpers.ts';

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
    // Launch prices come from a migration: birthday 520, signature 480, classic 360.
    assert.equal(menu.data.orderingEnabled, true);
    assert.deepEqual(menu.data.categories.map((c: any) => [...new Set(c.items.map((i: any) => i.priceSatang))]), [[52000], [48000], [36000]]);
    assert.deepEqual(menu.data.categories.map((c: any) => [c.name, c.items.length]), [['Kenneth’s Birthday Special', 3], ['Signature Cocktails', 6], ['Classic Cocktails', 12]]);
    const negroni = menu.data.categories[2].items.find((i: any) => i.name === 'Negroni');
    assert.deepEqual(negroni.ingredients, ['Gin', 'Campari', 'Sweet vermouth', 'Orange peel']);
    assert.deepEqual(menu.data.categories[1].items[0].ingredients, []); // signature recipes come from the bar
    const light = menu.data.categories[1].items.find((i: any) => i.name === 'The Morning Light');
    assert.equal(light.imageUrl, '/static/menu/the-morning-light.webp');
    assert.equal(light.thumbUrl, '/static/menu/the-morning-light-thumb.webp');
    assert.equal(menu.data.categories[1].items[0].imageUrl, null); // only The Morning Light has a photo so far
    assert.deepEqual(light.ingredients, ['Suntory Kakubin Whiskey', 'Chrysanthemum liqueur', 'Cointreau', 'Wild honey', 'Lemon juice', 'Angostura bitters', 'Sea salt']);
    assert.match(light.description, /^“The Morning Light” is a homage to Hiroshi Senju/);
    assert.match(light.description, /deeply rooted in nature\.$/);
    // Guests see names only: no amounts, method or garnish.
    assert.doesNotMatch(JSON.stringify([light.ingredients, light.description]), /\d|\bml\b|dash|pinch|shake|garnish|rosemary|peel/i);
    for (const u of [light.imageUrl, light.thumbUrl]) assert.equal((await http(env, 'GET', u)).status, 200); // files are actually served
    const naoko = menu.data.categories[1].items.find((i: any) => i.name === 'Naoko');
    assert.equal(naoko.imageUrl, '/static/menu/naoko.webp');
    assert.equal(naoko.thumbUrl, '/static/menu/naoko-thumb.webp');
    assert.equal(naoko.fullUrl, '/static/menu/naoko-full.webp');
    assert.equal(light.fullUrl, '/static/menu/the-morning-light-full.webp');
    for (const u of [naoko.imageUrl, naoko.thumbUrl, naoko.fullUrl, light.fullUrl]) assert.equal((await http(env, 'GET', u)).status, 200);
    const basket = menu.data.categories.flatMap((c: any) => c.items).find((i: any) => i.name === 'The Basket Case');
    for (const u of [basket.imageUrl, basket.thumbUrl, basket.fullUrl]) assert.equal((await http(env, 'GET', u)).status, 200);
    const k224 = menu.data.categories[0].items.find((i: any) => i.name === '224');
    for (const u of [k224.imageUrl, k224.thumbUrl, k224.fullUrl]) assert.equal((await http(env, 'GET', u)).status, 200);
    for (const n of ['33', 'Infinity']) {
      const it = menu.data.categories[0].items.find((i: any) => i.name === n);
      for (const u of [it.imageUrl, it.thumbUrl, it.fullUrl]) assert.equal((await http(env, 'GET', u)).status, 200);
    }
    const k33 = menu.data.categories[0].items.find((i: any) => i.name === '33');
    assert.match(k33.description, /^Somewhere between what has passed/);
    assert.match(k33.description, /beauty of the in-between\.$/);
    assert.deepEqual(k33.ingredients, ['Bijofu Tokubetsu Junmai', 'Newby Oriental Sencha', 'Sea salt', 'Wild honey']);
    const inf = menu.data.categories[0].items.find((i: any) => i.name === 'Infinity');
    assert.match(inf.description, /^We mistake endings for disappearance\.\n\n/);
    assert.match(inf.description, /sweetness and desire\.$/);
    assert.deepEqual(inf.ingredients, ['Pink Gin', 'Chrysanthemum', 'Wild Honey', 'Rose']);
    assert.match(k224.description, /^The music has faded/);
    assert.equal(k224.ingredients.length, 8);
    assert.doesNotMatch(JSON.stringify(k224.ingredients), /\d|\bml\b|drop/i);
    assert.match(basket.description, /^Inspired by the character Allison/);
    assert.equal(basket.ingredients.length, 10);
    assert.doesNotMatch(JSON.stringify(basket.ingredients), /\d|\bml\b|dash/i);
    assert.match(naoko.description, /^Naoko is a vivid green cocktail that conceals a quiet melancholy/);
    assert.match(naoko.description, /until the final notes are all that remain\.$/);
    assert.deepEqual(naoko.ingredients, ['Mexicat Tequila', 'Green Fanta (preferably zero sugar)', 'Midori Melon Liqueur', 'Chrysanthemum Liqueur', 'Lime Juice', 'Saline solution', 'Keto Green Apple Syrup', 'Fresh Cucumbers', 'Fresh Orange Peels', 'Fresh Mint leaves']);
    // Guests see names only: no amounts, method or garnish line.
    assert.doesNotMatch(JSON.stringify([naoko.ingredients, naoko.description]), /\d|\bml\b|\bdrops?\b|double strain|garnish|shake/i);
    const s = await openTable(env, 1);
    const token = await join(env, 1, s.join_pin);
    // Price all but one (start from an unpriced menu: the launch prices come from a migration).
    env.app.ctx.db.run('UPDATE menu_items SET price_satang = NULL');
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

  test('per-drink notes: stored on the line, shown to staff under that drink, same drink + different note stays separate', async () => {
    const e = (env = await setup());
    const s = await openTable(e, 1);
    const token = await join(e, 1, s.join_pin);
    const mojito = await menuId(e, 'mojito');
    const body = {
      items: [
        { menuItemId: mojito, quantity: 1, note: '  less   ice\u0007 ' },
        { menuItemId: mojito, quantity: 2, note: 'less ice' },        // merges with the line above (same note after cleaning)
        { menuItemId: mojito, quantity: 1 },                          // no note -> its own line
        { menuItemId: await menuId(e, 'negroni'), quantity: 1, note: 'no orange peel, allergic to citrus oils' },
      ],
      idempotencyKey: 'note-order-0001',
    };
    const r = await http(e, 'POST', '/api/public/orders', body, auth(token));
    assert.equal(r.status, 201);
    assert.deepEqual(
      r.data.order.items.map((i: any) => [i.name, i.quantity, i.note]),
      [['Negroni', 1, 'no orange peel, allergic to citrus oils'], ['Mojito', 1, ''], ['Mojito', 3, 'less ice']], // menu order, then note
    );
    assert.equal(r.data.order.totalSatang, 5 * 22000);
    await e.drain();
    const card = e.tg.sent((t) => t.includes('NEW COCKTAIL ORDER'))[0].params.text as string;
    assert.match(card, /3 × Mojito\s+฿660\n  ↳ less ice\n/);
    assert.match(card, /1 × Negroni\s+฿220\n  ↳ no orange peel, allergic\n    to citrus oils\n/); // wrapped to the card width
    // Guests see the notes in their order history too, and the bill still totals correctly.
    const orders = await http(e, 'GET', '/api/public/session/orders', undefined, auth(token));
    assert.equal(orders.data.orders[0].items[2].note, 'less ice');
    const bill = await http(e, 'GET', '/api/public/session/bill', undefined, auth(token));
    assert.equal(bill.data.bill.totalSatang, 5 * 22000);
    // Same key with a different note is a different request.
    const changed = { ...body, items: body.items.map((i, n) => (n === 0 ? { ...i, note: 'extra ice' } : i)) };
    assert.equal((await http(e, 'POST', '/api/public/orders', changed, auth(token))).data.error.code, 'IDEMPOTENCY_MISMATCH');
    // Validation.
    const bad = async (note: unknown) => (await http(e, 'POST', '/api/public/orders', { items: [{ menuItemId: mojito, quantity: 1, note }], idempotencyKey: `bad-note-${Math.random().toString(36).slice(2, 10)}` }, auth(token)));
    assert.equal((await bad('x'.repeat(101))).data.error.code, 'NOTES_TOO_LONG');
    assert.equal((await bad(42)).data.error.code, 'INVALID_NOTES');
    assert.equal((await bad('x'.repeat(100))).status, 201);
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

  test('the 224 logo is in place: served to guests and available for the receipt', async () => {
    env = await setup();
    for (const file of ['logo-224-header.webp', 'logo-224-lockup.webp']) {
      const img = await http(env, 'GET', `/static/${file}`);
      assert.equal(img.status, 200, file);
      assert.equal(img.headers.get('content-type'), 'image/webp');
    }
    assert.ok(fs.existsSync(env.config.receipt.logoPath), 'receipt logo file missing');
    assert.equal(fs.readFileSync(env.config.receipt.logoPath).subarray(1, 4).toString(), 'PNG');
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
