import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Ctx } from '../context.ts';
import { authenticate, joinSession, requireCurrent, type CustomerAuth } from '../domain/access.ts';
import { currentBillView, requestPayment } from '../domain/billing.ts';
import { getMenu, menuReadiness } from '../domain/menu.ts';
import { placeOrder, sessionOrders } from '../domain/orders.ts';
import { getActiveSession, getTableByQrToken } from '../domain/tables.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { safeEqual } from '../lib/ids.ts';
import { RateLimiter } from '../lib/ratelimit.ts';
import { generateReceipt, readReceiptPdf } from '../receipts/service.ts';
import type { ReceiptRow } from '../receipts/model.ts';
import type { TelegramClient } from '../telegram/api.ts';
import { handleUpdate } from '../telegram/bot.ts';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../../public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  ip: string;
  body: unknown;
  rawBody: Buffer;
}

type Result =
  | { status?: number; json: unknown; headers?: Record<string, string> }
  | { status?: number; body: Buffer | string; contentType: string; headers?: Record<string, string> };

type Handler = (req: Req) => Result | Promise<Result>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  maxBody: number;
}

function compile(pattern: string) {
  const keys: string[] = [];
  const re = pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
    keys.push(k);
    return '([A-Za-z0-9_-]{1,128})';
  });
  return { pattern: new RegExp(`^${re}$`), keys };
}

export function createHttpServer(ctx: Ctx, tg: TelegramClient) {
  const limiter = new RateLimiter();
  const routes: Route[] = [];
  const add = (method: string, p: string, handler: Handler, maxBody = 16 * 1024) => routes.push({ method, ...compile(p), handler, maxBody });

  const limit = (key: string, max: number, windowMs = 60_000) => {
    if (!limiter.hit(key, max, windowMs)) throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.');
  };
  const bearer = (req: Req) => {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
  };
  const customer = (req: Req, bucket: string, max: number): CustomerAuth => {
    limit(`${bucket}:ip:${req.ip}`, max * 4);
    const auth = authenticate(ctx, bearer(req));
    limit(`${bucket}:access:${auth.access.id}`, max);
    return auth;
  };

  const orderView = (o: ReturnType<typeof sessionOrders>[number]) => ({
    orderNumber: o.order_number,
    status: o.status,
    notes: o.notes,
    totalSatang: o.total_satang,
    createdAt: o.created_at,
    servedAt: o.served_at,
    items: o.items.map((i) => ({ name: i.item_name_snapshot, quantity: i.quantity, unitPriceSatang: i.unit_price_satang, lineTotalSatang: i.line_total_satang })),
  });

  const sessionView = (auth: CustomerAuth) => ({
    code: auth.session.session_code,
    status: auth.session.status,
    isCurrent: auth.isCurrent,
    tableNumber: auth.table.display_number,
  });

  const statusView = (auth: CustomerAuth) => {
    const s = auth.session;
    const bill = currentBillView(ctx.db, ctx.config, s);
    let payment = null;
    let receipt = null;
    if (s.status === 'PAID_CLOSED') {
      const p = ctx.db.get<{ amount_satang: number; method: string; confirmed_at: string; receipt_token: string | null; generated_at: string | null; receipt_number: string | null }>(
        `SELECT p.amount_satang, p.method, p.confirmed_at, r.lookup_token AS receipt_token, r.generated_at, r.receipt_number
         FROM payments p JOIN bills b ON b.id = p.bill_id LEFT JOIN receipts r ON r.payment_id = p.id
         WHERE b.session_id = ? AND p.status = 'CONFIRMED'`,
        [s.id],
      );
      if (p) {
        payment = { amountSatang: p.amount_satang, method: p.method, confirmedAt: p.confirmed_at };
        if (ctx.config.receipt.customerDownload && p.receipt_token) {
          receipt = { number: p.receipt_number, ready: !!p.generated_at, url: `/api/public/receipt/${p.receipt_token}` };
        }
      }
    }
    const cancelled = s.status === 'OPEN'
      ? ctx.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM bills WHERE session_id = ? AND status = 'CANCELLED'", [s.id])!.c > 0
      : false;
    return {
      session: sessionView(auth),
      orders: sessionOrders(ctx.db, s.id).map(orderView),
      bill,
      billWasReopened: cancelled,
      payment,
      receipt,
      orderingEnabled: auth.isCurrent && s.status === 'OPEN' && menuReadiness(ctx.db).ready,
    };
  };

  // ---- Public customer API ------------------------------------------------
  add('GET', '/api/public/table/:qrToken', (req) => {
    limit(`table:${req.ip}`, 60);
    const table = getTableByQrToken(ctx.db, req.params.qrToken);
    if (!table) throw notFound('TABLE_NOT_FOUND', 'This QR code is not recognised.');
    const session = getActiveSession(ctx.db, table);
    return {
      json: {
        venue: ctx.config.venue.name,
        table: { number: table.display_number, name: table.name },
        pinLength: ctx.config.access.pinLength,
        session: session ? { code: session.session_code, status: session.status } : null,
      },
    };
  });

  add('GET', '/api/public/menu', (req) => {
    limit(`menu:${req.ip}`, 60);
    const readiness = menuReadiness(ctx.db);
    return {
      json: {
        orderingEnabled: readiness.ready,
        categories: getMenu(ctx.db).map((c) => ({
          code: c.code,
          name: c.name,
          items: c.items.map((i) => ({
            id: i.id, name: i.name, description: i.description, priceSatang: i.price_satang,
            imageUrl: i.image_url, available: i.available === 1, ingredients: JSON.parse(i.ingredients) as string[],
          })),
        })),
      },
    };
  });

  add('POST', '/api/public/session/join', (req) => {
    limit(`join:${req.ip}`, 10);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.qrToken !== 'string' || typeof b.pin !== 'string') throw badRequest('INVALID_REQUEST', 'Please enter the PIN from staff.');
    return { json: joinSession(ctx, b.qrToken, b.pin.trim()) };
  });

  add('POST', '/api/public/orders', (req) => {
    const auth = customer(req, 'order', 8);
    requireCurrent(auth);
    const r = placeOrder(ctx, auth, req.body);
    return { status: r.replayed ? 200 : 201, json: { order: orderView({ ...r.order, items: r.items }), replayed: r.replayed } };
  });

  add('GET', '/api/public/session/orders', (req) => {
    const auth = customer(req, 'read', 240);
    return { json: { session: sessionView(auth), orders: sessionOrders(ctx.db, auth.session.id).map(orderView) } };
  });

  add('GET', '/api/public/session/bill', (req) => {
    const auth = customer(req, 'read', 240);
    return { json: { session: sessionView(auth), bill: currentBillView(ctx.db, ctx.config, auth.session) } };
  });

  add('POST', '/api/public/session/request-payment', (req) => {
    const auth = customer(req, 'pay', 6);
    requireCurrent(auth);
    const r = requestPayment(ctx, auth, req.body);
    return { status: r.created ? 201 : 200, json: { bill: r.bill } };
  });

  add('GET', '/api/public/session/status', (req) => {
    const auth = customer(req, 'read', 240);
    return { json: statusView(auth) };
  });

  add('GET', '/api/public/receipt/:secureToken', (req) => {
    limit(`receipt:${req.ip}`, 30);
    if (!ctx.config.receipt.customerDownload) throw notFound('NOT_FOUND', 'Receipt downloads are not enabled.');
    const receipt = ctx.db.get<ReceiptRow>('SELECT * FROM receipts WHERE lookup_token = ?', [req.params.secureToken]);
    if (!receipt) throw notFound('NOT_FOUND', 'Receipt not found.');
    const pdf = readReceiptPdf(ctx, receipt);
    if (!pdf) throw new AppError(404, 'RECEIPT_PENDING', 'Your receipt is being prepared. Please try again shortly.');
    return {
      body: pdf,
      contentType: 'application/pdf',
      headers: { 'content-disposition': `inline; filename="${receipt.receipt_number}.pdf"`, 'cache-control': 'private, no-store' },
    };
  });

  // ---- Integrations -------------------------------------------------------
  add(
    'POST',
    '/api/integrations/telegram/webhook',
    async (req) => {
      const secret = ctx.config.telegram.webhookSecret;
      if (!secret) throw new AppError(503, 'NOT_CONFIGURED', 'Webhook not configured');
      const got = req.headers['x-telegram-bot-api-secret-token'];
      if (typeof got !== 'string' || !safeEqual(got, secret)) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
      try {
        await handleUpdate(ctx, tg, req.body as never);
      } catch (err) {
        // Always 200 to Telegram once authenticated: handlers are idempotent and errors are logged.
        ctx.log.error('telegram update failed', { error: (err as Error).message });
      }
      return { json: { ok: true } };
    },
    1024 * 1024,
  );

  add('POST', '/api/internal/receipt/generate', async (req) => {
    const token = ctx.config.internalApiToken;
    const got = bearer(req);
    if (!token || !got || !safeEqual(got, token)) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const receipt = typeof b.receiptNumber === 'string'
      ? ctx.db.get<ReceiptRow>('SELECT * FROM receipts WHERE receipt_number = ?', [b.receiptNumber])
      : undefined;
    if (!receipt) throw notFound('NOT_FOUND', 'Receipt not found');
    const r = await generateReceipt(ctx, receipt.id, { send: b.resend === true });
    return { json: { ok: true, receiptNumber: receipt.receipt_number, ...r } };
  });

  add('GET', '/healthz', () => {
    const pending = ctx.db.get<{ c: number; oldest: string | null }>(
      'SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM outbox_events WHERE delivered_at IS NULL',
    )!;
    return { json: { ok: true, outboxPending: pending.c, outboxOldest: pending.oldest, menuReady: menuReadiness(ctx.db).ready } };
  });

  // ---- Static frontend ----------------------------------------------------
  const serveFile = (file: string, cache: string): Result => {
    const body = fs.readFileSync(file);
    return { body, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', headers: { 'cache-control': cache } };
  };
  add('GET', '/', () => serveFile(path.join(PUBLIC_DIR, 'index.html'), 'no-cache'));
  add('GET', '/t/:qrToken', () => serveFile(path.join(PUBLIC_DIR, 'index.html'), 'no-cache'));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const ip = (ctx.config.trustProxy && typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : req.socket.remoteAddress) ?? 'unknown';

    const send = (status: number, body: Buffer | string, contentType: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': contentType, ...headers });
      res.end(method === 'HEAD' ? undefined : body);
    };
    const sendJson = (status: number, json: unknown, headers: Record<string, string> = {}) =>
      send(status, JSON.stringify(json), 'application/json; charset=utf-8', { 'cache-control': 'no-store', ...headers });

    try {
      // Static assets under /static/
      if ((method === 'GET' || method === 'HEAD') && url.pathname.startsWith('/static/')) {
        const rel = path.normalize(decodeURIComponent(url.pathname.slice('/static/'.length)));
        const file = path.join(PUBLIC_DIR, rel);
        if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
        const r = serveFile(file, 'public, max-age=300') as { body: Buffer; contentType: string; headers: Record<string, string> };
        return send(200, r.body, r.contentType, r.headers);
      }

      const matchMethod = method === 'HEAD' ? 'GET' : method;
      let route: Route | undefined;
      let m: RegExpExecArray | null = null;
      let pathMatched = false;
      for (const r of routes) {
        const mm = r.pattern.exec(url.pathname);
        if (!mm) continue;
        pathMatched = true;
        if (r.method === matchMethod) {
          route = r;
          m = mm;
          break;
        }
      }
      if (!route || !m) return sendJson(pathMatched ? 405 : 404, { error: { code: pathMatched ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', message: 'Not found' } });

      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = m![i + 1]));

      let rawBody = Buffer.alloc(0);
      let body: unknown = undefined;
      if (method === 'POST') {
        const type = String(req.headers['content-type'] ?? '');
        if (!type.startsWith('application/json')) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > route.maxBody) throw new AppError(413, 'TOO_LARGE', 'Request too large');
          chunks.push(chunk as Buffer);
        }
        rawBody = Buffer.concat(chunks);
        try {
          body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
        } catch {
          throw badRequest('INVALID_JSON', 'Malformed JSON');
        }
      }

      const result = await route.handler({ method, path: url.pathname, params, headers: req.headers, ip, body, rawBody });
      if ('json' in result) return sendJson(result.status ?? 200, result.json, result.headers);
      return send(result.status ?? 200, result.body, result.contentType, result.headers);
    } catch (err) {
      if (err instanceof AppError) {
        return sendJson(err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
      }
      ctx.log.error('request failed', { path: url.pathname, error: (err as Error).message });
      return sendJson(500, { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
    }
  });
  return server;
}
