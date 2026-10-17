/**
 * Read-only Cloudflare Workers smoke-test entrypoint.
 *
 * NOT the production ordering backend. Writes return 503 until the
 * synchronous Node domain/transaction services are migrated.
 */
interface D1Statement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}

export interface Env {
  DB: { prepare(sql: string): D1Statement };
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      try {
        await env.DB.prepare('SELECT 1 AS ok').first();
        return json({ ok: true, database: 'connected', mode: 'read-only-preview' });
      } catch {
        return json({ ok: false, database: 'unavailable' }, 503);
      }
    }
    if (url.pathname === '/api/public/menu' && request.method === 'GET') {
      try {
        const [categories, items, missing] = await Promise.all([
          env.DB.prepare('SELECT id, code, name FROM menu_categories ORDER BY sort_order').all(),
          env.DB.prepare('SELECT * FROM menu_items ORDER BY category_id, sort_order').all(),
          env.DB.prepare('SELECT COUNT(*) AS count FROM menu_items WHERE price_satang IS NULL').first<{count:number}>(),
        ]);
        const grouped = categories.results.map(category => ({
          ...category,
          items: items.results.filter(item => item.category_id === category.id),
        }));
        return json({ categories: grouped, orderingEnabled: false, priceReady: missing?.count === 0 });
      } catch {
        return json({ error: 'MENU_NOT_READY' }, 503);
      }
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      return json({ error: 'ORDERING_NOT_AVAILABLE', message: 'This preview is read-only. Ordering and payment are disabled.' }, 503);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
    }
    return env.ASSETS.fetch(request);
  },
};
