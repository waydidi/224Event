import type { Config } from './config.ts';
import type { Database } from './db/database.ts';
import type { Logger } from './lib/log.ts';

export interface Ctx {
  config: Config;
  db: Database;
  log: Logger;
  now: () => Date;
  /** Called after a transaction enqueues outbox work so it can be delivered promptly. */
  kick: () => void;
}

export const nowIso = (ctx: Pick<Ctx, 'now'>) => ctx.now().toISOString();
