/**
 * End-to-end smoke test for the Cloudflare build. Start the Worker locally first, pointing Telegram at the fake server below:
 *
 *   npx wrangler dev --local --port 8791 --var INTERNAL_API_TOKEN:admintoken --var TELEGRAM_WEBHOOK_SECRET:whsecret \
 *     --var TELEGRAM_BOT_TOKEN:123:TEST --var TELEGRAM_STAFF_CHAT_ID:-100123 --var TELEGRAM_API_BASE:http://127.0.0.1:8792
 *   node --disable-warning=ExperimentalWarning scripts/cf-smoke.ts
 */
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8791';
const ADMIN = { authorization: 'Bearer admintoken' };
const HOOK = { 'x-telegram-bot-api-secret-token': 'whsecret', 'content-type': 'application/json' };
const CHAT = -100123;
const STAFF = 777;

// ---- fake Telegram ----------------------------------------------------------
const calls: { method: string; body: any; raw: Buffer }[] = [];
let mid = 100;
let failNext = 0; // simulate a Telegram outage
const tg = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const method = (req.url ?? '').split('/').pop()!;
    if (failNext > 0) {
      failNext--;
      res.statusCode = 502;
      return res.end('{"ok":false,"description":"simulated outage"}');
    }
    let body: any = null;
    if ((req.headers['content-type'] ?? '').includes('json')) body = JSON.parse(raw.toString() || '{}');
    calls.push({ method, body, raw });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: ++mid } }));
  });
}).listen(8792);

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(BASE + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, data: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) } as { status: number; data: any };
};
const admin = (command: string, args: string[] = []) => api('POST', '/api/internal/admin', { command, args }, ADMIN);
let uid = Date.now();
const hook = (update: object) => api('POST', '/api/integrations/telegram/webhook', { update_id: uid++, ...update }, HOOK);
const say = (text: string) => hook({ message: { message_id: uid, chat: { id: CHAT, type: 'supergroup' }, from: { id: STAFF, first_name: 'S' }, text } });
const tap = (data: string) => hook({ callback_query: { id: `cq${uid}`, from: { id: STAFF }, data, message: { message_id: 1, chat: { id: CHAT, type: 'supergroup' } } } });
const until = async <T>(what: string, fn: () => T | Promise<T>, ms = 15000): Promise<NonNullable<T>> => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const buttons = (m: { body: any }) => (m.body?.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data: string }[];
const step = (s: string) => console.log('✓', s);

try {
  assert.equal((await api('GET', '/')).status, 200);
  assert.equal((await api('GET', '/static/app.js')).status, 200);
  assert.equal((await api('GET', '/static/menu/the-morning-light.webp')).status, 200);
  assert.equal((await api('GET', '/static/..%2Fpackage.json')).status, 404);
  step('static frontend and photos served');

  const ens = await admin('tables:ensure', ['7']);
  assert.equal(ens.status, 200);
  const url = ens.data.output.find((l: string) => l.startsWith('Table 1\t')).split('\t')[1] as string;
  const qrToken = url.split('/t/')[1];
  assert.equal((await admin('staff:add', [String(STAFF), 'cashier', 'Smoke Cashier'])).status, 200);
  assert.equal((await api('GET', '/api/internal/qr-sheet.pdf', undefined, ADMIN)).data.subarray(0, 5).toString(), '%PDF-');
  step('tables, staff and QR sheet created through the admin endpoint');

  assert.equal((await api('POST', '/api/integrations/telegram/webhook', { update_id: 1 }, { ...HOOK, 'x-telegram-bot-api-secret-token': 'wrong' })).status, 401);
  await say('/open_table 1');
  const opened = await until('open-table card', () => calls.find((c) => c.method === 'sendMessage' && /Join PIN/.test(c.body?.text ?? '')));
  const joinPin = /Join PIN: <code>(\d+)<\/code>/.exec(opened.body.text)![1];
  step(`staff opened table 1 from Telegram (PIN ${joinPin})`);

  const table = await api('GET', `/api/public/table/${qrToken}`);
  assert.equal(table.data.table.number, 1);
  const joined = await api('POST', '/api/public/session/join', { qrToken, pin: joinPin });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  const bearer = { authorization: `Bearer ${joined.data.visitToken}` };
  step('guest scanned the QR and joined with the PIN');

  const menu = await api('GET', '/api/public/menu');
  assert.equal(menu.data.orderingEnabled, true);
  const item = menu.data.categories[0].items[0];
  const placed = await api('POST', '/api/public/orders', { items: [{ menuItemId: item.id, quantity: 2 }], idempotencyKey: 'k-' + Date.now() }, bearer);
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  const orderCard = await until('order card in the staff group', () => calls.find((c) => c.method === 'sendMessage' && /NEW COCKTAIL ORDER/i.test(c.body?.text ?? '')));
  step(`order ${placed.data.order.orderNumber} reached the staff group`);

  await tap(buttons(orderCard).find((b) => /Served/.test(b.text))!.callback_data);
  await until('order marked served', async () => (await api('GET', '/api/public/session/status', undefined, bearer)).data.orders[0].status === 'SERVED');
  step('staff tapped "Mark as Served"');

  const bill = (await api('GET', '/api/public/session/bill', undefined, bearer)).data.bill;
  const pay = await api('POST', '/api/public/session/request-payment', { expectedTotalSatang: bill.totalSatang, expectedOrderCount: bill.orderNumbers.length }, bearer);
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  const payCard = await until('payment card', () => calls.find((c) => c.method === 'sendMessage' && buttons(c).some((b) => /Cash/.test(b.text))));
  step('guest requested payment; payment card reached the staff group');

  await tap(buttons(payCard).find((b) => /Cash/.test(b.text))!.callback_data);
  const doc = await until('receipt PDF sent to Telegram', () => calls.find((c) => c.method === 'sendDocument'), 30000);
  assert.ok(doc.raw.includes('%PDF-'), 'sendDocument body contains a PDF');
  step(`staff confirmed cash payment; receipt PDF (${doc.raw.length} bytes) sent to the group`);

  const final = (await api('GET', '/api/public/session/status', undefined, bearer)).data;
  assert.equal(final.session.status, 'PAID_CLOSED');
  const rcpt = await api('GET', final.receipt.url);
  assert.equal(rcpt.status, 200);
  assert.equal(rcpt.data.subarray(0, 5).toString(), '%PDF-');
  if (process.env.SAVE_RECEIPT) (await import('node:fs')).writeFileSync(process.env.SAVE_RECEIPT, rcpt.data);
  step('session closed; customer can download the receipt');
  // Telegram outage: the card must still arrive later through the retry alarm.
  failNext = 2;
  const before = calls.length;
  await say('/open_table 2');
  const late = await until('card delivered after the outage (alarm retry)', () => calls.slice(before).find((c) => c.method === 'sendMessage' && /TABLE 2 OPENED/.test(c.body?.text ?? '')), 40000);
  assert.ok(late);
  step('Telegram outage: queued card was retried by the Durable Object alarm and delivered');
  console.log('\nALL CLOUDFLARE SMOKE CHECKS PASSED');
} catch (e) {
  console.error('FAILED:', (e as Error).message);
  console.error('Telegram calls seen:', JSON.stringify(calls.map((c) => [c.method, c.body?.text?.slice(0, 160)])));
  process.exitCode = 1;
} finally {
  tg.close();
}
