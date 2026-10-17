import type { Config } from './config.ts';
import type { Database } from './db/database.ts';
import type { Logger } from './lib/log.ts';
import type { ReceiptAssets } from './receipts/pdf.ts';

export interface Ctx {
  config: Config;
  db: Database;
  log: Logger;
  now: () => Date;
  /** Fonts and logo bytes for receipt PDFs (read from disk on Node, bundled on Cloudflare). */
  receiptAssets: ReceiptAssets;
  /** Called after a transaction enqueues outbox work so it can be delivered promptly. */
  kick: () => void;
}

export const nowIso = (ctx: Pick<Ctx, 'now'>) => ctx.now().toISOString();
