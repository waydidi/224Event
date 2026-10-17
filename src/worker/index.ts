/**
 * Cloudflare Worker entry.
 *
 *   browser / Telegram ──► Worker ──► static files from the assets binding (/static/*, index.html)
 *                                 └─► one Durable Object ("Venue") that owns the SQLite database,
 *                                     the HTTP API, the Telegram bot logic and the outbox retries.
 *
 * Every request that touches data goes through the single Venue object, which runs one request at a
 * time, so the "one payment per bill" and "one session per table" rules hold exactly as on Node.
 */
import { DurableObject, type DurableObjectState } from 'cloudflare:workers';
import { loadConfig } from '../config.ts';
import type { Ctx } from '../context.ts';
import { DurableObjectDatabase } from '../db/do-engine.ts';
import { consoleLogger } from '../lib/log.ts';
import { createHandler, MIME, SECURITY_HEADERS } from '../http/router.ts';
import { OutboxWorker } from '../outbox/worker.ts';
import { HttpTelegramClient } from '../telegram/api.ts';
import interBold from '../../assets/fonts/Inter-Bold.otf';
import interMedium from '../../assets/fonts/Inter-Medium.otf';
import interRegular from '../../assets/fonts/Inter-Regular.otf';
import receiptLogo from '../../assets/receipt-logo.png';

interface Env {
  VENUE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  ASSETS: { fetch(request: Request): Promise<Response> };
  [key: string]: unknown;
}

const VENUE_NAME = '224-live-house';
const notFound = () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function serveAsset(env: Env, request: Request, path: string, cache: string): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: 'GET' }));
  if (!res.ok) return notFound();
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return new Response(request.method === 'HEAD' ? null : res.body, {
    status: 200,
    headers: { ...SECURITY_HEADERS, 'content-type': MIME[ext] ?? res.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': cache },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (url.pathname.startsWith('/static/')) {
        let rel: string;
        try {
          rel = decodeURIComponent(url.pathname.slice('/static/'.length));
        } catch {
          return notFound();
        }
        if (!rel || rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) return notFound();
        return serveAsset(env, request, `/${rel}`, 'public, max-age=300');
      }
      if (url.pathname === '/' || /^\/t\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) return serveAsset(env, request, '/index.html', 'no-cache');
    }
    return env.VENUE.get(env.VENUE.idFromName(VENUE_NAME)).fetch(request);
  },
};

export class Venue extends DurableObject<Env> {
  private handle!: (request: Request, ip: string) => Promise<Response>;
  private worker!: OutboxWorker;
  private core!: Ctx;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    state.blockConcurrencyWhile(async () => {
      const config = loadConfig(env as unknown as Record<string, string | undefined>);
      const db = new DurableObjectDatabase(state.storage);
      db.migrate();
      const tg = new HttpTelegramClient(config.telegram.apiBase, config.telegram.botToken);
      this.core = {
        config,
        db,
        log: consoleLogger,
        now: () => new Date(),
        receiptAssets: {
          fonts: { regular: new Uint8Array(interRegular), medium: new Uint8Array(interMedium), bold: new Uint8Array(interBold) },
          logo: new Uint8Array(receiptLogo),
        },
        kick: () => this.kick(),
      };
      this.worker = new OutboxWorker(this.core, tg);
      this.handle = createHandler(this.core, tg, async () => null);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const response = await this.handle(request, ip);
    await this.armAlarm();
    return response;
  }

  /** Deliver queued Telegram work now and make sure we wake up again for retries. */
  private kick() {
    this.worker.kick();
    void this.armAlarm(Date.now() + 1000);
  }

  async alarm(): Promise<void> {
    await this.worker.drain();
    await this.armAlarm();
  }

  /** Wake at the next time an undelivered outbox event is due (retries survive restarts). */
  private async armAlarm(atLeast = 0) {
    const next = this.core.db.get<{ t: string | null }>('SELECT MIN(next_retry_at) AS t FROM outbox_events WHERE delivered_at IS NULL')?.t;
    if (!next) return;
    await this.ctx.storage.setAlarm(Math.max(Date.parse(next), atLeast, Date.now() + 1000));
  }
}
