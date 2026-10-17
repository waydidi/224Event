import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { NodeDatabase } from '../src/db/node-engine.ts';
import { setPrice } from '../src/domain/menu.ts';
import { upsertStaff } from '../src/domain/staff.ts';
import { ensureTables } from '../src/domain/tables.ts';
import { silentLogger } from '../src/lib/log.ts';
import { TelegramError, type TelegramClient } from '../src/telegram/api.ts';

export const STAFF_CHAT = '-100777';
export const SECRET = 'test-webhook-secret';
export const USERS = { server: 1001, cashier: 2002, lead: 3003, stranger: 9999 };

export class FakeTelegram implements TelegramClient {
  readonly configured = true;
  calls: { method: string; params: any }[] = [];
  documents: { chatId: string; filename: string; data: Uint8Array; caption: string }[] = [];
  failing = false;
  private nextId = 100;

  async call(method: string, params: Record<string, unknown>) {
    if (this.failing && method !== 'answerCallbackQuery') throw new TelegramError(method, 502, 'Bad Gateway');
    this.calls.push({ method, params });
    if (method === 'sendMessage') return { message_id: this.nextId++ };
    return true as any;
  }

  async sendDocument(chatId: string, filename: string, data: Uint8Array, caption: string) {
    if (this.failing) throw new TelegramError('sendDocument', 502, 'Bad Gateway');
    this.documents.push({ chatId, filename, data, caption });
    return { message_id: this.nextId++ };
  }

  sent(predicate: (text: string) => boolean = () => true) {
    return this.calls.filter((c) => c.method === 'sendMessage' && predicate(c.params.text));
  }
  edits(predicate: (text: string) => boolean = () => true) {
    return this.calls.filter((c) => c.method === 'editMessageText' && predicate(c.params.text));
  }
  answers() {
    return this.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params.text as string);
  }
  /** callback_data of the inline button whose label matches. */
  button(label: RegExp, from: 'sent' | 'any' = 'any'): string {
    const msgs = [...this.calls].reverse().filter((c) => (from === 'sent' ? c.method === 'sendMessage' : c.method === 'sendMessage' || c.method === 'editMessageText'));
    for (const m of msgs) {
      for (const row of m.params.reply_markup?.inline_keyboard ?? []) for (const b of row) if (label.test(b.text)) return b.callback_data;
    }
    throw new Error(`No button ${label}`);
  }
}

export interface TestEnv {
  app: App;
  tg: FakeTelegram;
  base: string;
  clock: { t: number };
  config: Config;
  qr: (n: number) => string;
  advance: (ms: number) => void;
  drain: () => Promise<void>;
  close: () => Promise<void>;
  updateId: number;
}

export async function setup(opts: { prices?: boolean; env?: Record<string, string> } = {}): Promise<TestEnv> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), '224-test-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    TELEGRAM_STAFF_CHAT_ID: STAFF_CHAT,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_BOT_TOKEN: '123456:TEST',
    INTERNAL_API_TOKEN: 'internal-test-token',
    PUBLIC_BASE_URL: 'https://orders.example.com',
    OUTBOX_POLL_INTERVAL_MS: '60000',
    ...opts.env,
  });
  const clock = { t: Date.parse('2026-10-16T13:00:00.000Z') };
  const tg = new FakeTelegram();
  const app = createApp(config, { telegram: tg, log: silentLogger, now: () => new Date(clock.t), db: new NodeDatabase(':memory:') });
  const ctx = app.ctx;
  const tables = ensureTables(ctx, 3);
  upsertStaff(ctx, String(USERS.server), 'Mali (server)', 'server');
  upsertStaff(ctx, String(USERS.cashier), 'Somchai (cashier)', 'cashier');
  upsertStaff(ctx, String(USERS.lead), 'Ploy (lead)', 'lead');
  if (opts.prices !== false) {
    // Test-only prices (NOT approved menu prices).
    const prices: Record<string, number> = { 'lost-cherry': 28000, negroni: 22000, mojito: 22000 };
    for (const item of ctx.db.all<{ code: string }>('SELECT code FROM menu_items')) setPrice(ctx, item.code, prices[item.code] ?? 25000, { type: 'system' });
  }
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const env: TestEnv = {
    app, tg, base, clock, config,
    qr: (n) => tables.find((t) => t.display_number === n)!.permanent_qr_token,
    advance: (ms) => { clock.t += ms; },
    drain: () => app.worker.drain(),
    close: async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
    updateId: 1,
  };
  return env;
}

export async function http(env: TestEnv, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(env.base + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data: data as any, headers: res.headers };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

export async function webhook(env: TestEnv, update: Record<string, unknown>, secret = SECRET) {
  const r = await http(env, 'POST', '/api/integrations/telegram/webhook', { update_id: env.updateId++, ...update }, { 'x-telegram-bot-api-secret-token': secret });
  await env.drain();
  return r;
}

export function command(env: TestEnv, from: number, text: string, chatId: string = STAFF_CHAT) {
  return webhook(env, { message: { message_id: env.updateId, chat: { id: Number(chatId), type: 'supergroup' }, from: { id: from, first_name: 'x' }, text } });
}

export function tap(env: TestEnv, from: number, callbackData: string, chatId: string = STAFF_CHAT) {
  return webhook(env, {
    callback_query: { id: `cq${env.updateId}`, from: { id: from }, data: callbackData, message: { message_id: 1, chat: { id: Number(chatId), type: 'supergroup' } } },
  });
}

export async function openTable(env: TestEnv, n: number) {
  await command(env, USERS.cashier, `/open_table ${n}`);
  const t = env.app.ctx.db.get<{ id: number }>('SELECT id FROM tables WHERE display_number = ?', [n])!;
  return env.app.ctx.db.get<{ session_code: string; join_pin: string; id: number }>(
    "SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('OPEN','PAYMENT_REQUESTED')", [t.id],
  )!;
}

export async function join(env: TestEnv, n: number, pin: string) {
  const r = await http(env, 'POST', '/api/public/session/join', { qrToken: env.qr(n), pin });
  if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.visitToken as string;
}

export async function menuId(env: TestEnv, code: string) {
  return env.app.ctx.db.get<{ id: number }>('SELECT id FROM menu_items WHERE code = ?', [code])!.id;
}

export async function order(env: TestEnv, token: string, items: [string, number][], extra: Record<string, unknown> = {}) {
  const body = { items: await Promise.all(items.map(async ([c, q]) => ({ menuItemId: await menuId(env, c), quantity: q }))), idempotencyKey: `key-${Math.random().toString(36).slice(2, 12)}`, ...extra };
  const r = await http(env, 'POST', '/api/public/orders', body, auth(token));
  await env.drain();
  return r;
}
