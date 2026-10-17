import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Ctx } from '../context.ts';
import type { TelegramClient } from '../telegram/api.ts';
import { createHandler, type StaticFiles } from './router.ts';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../../public');

const diskFiles: StaticFiles = async (rel) => {
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { body: fs.readFileSync(file) };
};

/** Node http adapter around the web-standard handler (used locally, in tests and on Fly.io). */
export function createHttpServer(ctx: Ctx, tg: TelegramClient) {
  const handle = createHandler(ctx, tg, diskFiles);
  return http.createServer(async (req, res) => {
    const fwd = req.headers['x-forwarded-for'];
    const ip = (ctx.config.trustProxy && typeof fwd === 'string' ? fwd.split(',')[0].trim() : req.socket.remoteAddress) ?? 'unknown';
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
      method: req.method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
    const response = await handle(request, ip);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
}
