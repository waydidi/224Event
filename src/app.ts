import type { Config } from './config.ts';
import type { Ctx } from './context.ts';
import type { Database } from './db/database.ts';
import { NodeDatabase } from './db/node-engine.ts';
import { createHttpServer } from './http/server.ts';
import { consoleLogger, type Logger } from './lib/log.ts';
import { nodeReceiptAssets } from './receipts/assets-node.ts';
import { OutboxWorker } from './outbox/worker.ts';
import { HttpTelegramClient, type TelegramClient } from './telegram/api.ts';

export interface App {
  ctx: Ctx;
  worker: OutboxWorker;
  server: ReturnType<typeof createHttpServer>;
  telegram: TelegramClient;
  close(): Promise<void>;
}

export function createApp(config: Config, opts: { telegram?: TelegramClient; log?: Logger; now?: () => Date; db?: Database } = {}): App {
  const db = opts.db ?? new NodeDatabase(config.databasePath);
  db.migrate();
  const telegram = opts.telegram ?? new HttpTelegramClient(config.telegram.apiBase, config.telegram.botToken);
  let worker: OutboxWorker | undefined;
  const ctx: Ctx = {
    config,
    db,
    log: opts.log ?? consoleLogger,
    now: opts.now ?? (() => new Date()),
    receiptAssets: nodeReceiptAssets(config),
    kick: () => worker?.kick(),
  };
  worker = new OutboxWorker(ctx, telegram);
  const server = createHttpServer(ctx, telegram);
  return {
    ctx,
    worker,
    server,
    telegram,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await worker!.stop();
      db.close();
    },
  };
}
