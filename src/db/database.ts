import { migrations } from './migrations.ts';

export type Param = string | number | bigint | null | Uint8Array;
export type Params = Param[];
export type Row = Record<string, any>;

/** What a SQLite backend (node:sqlite locally, a Durable Object's SQLite on Cloudflare) must provide. */
export interface Engine {
  exec(sql: string): void;
  run(sql: string, params: Params): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(sql: string, params: Params): Row[];
  /** Run fn atomically; throwing rolls everything back. fn must be synchronous. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * Thin synchronous wrapper around an Engine.
 *
 * SQLite runs in-process and every statement is synchronous, so a transaction
 * holds the write lock for its whole (synchronous) body: payment request,
 * payment confirmation and session rollover are fully serialized without
 * explicit row locks. On Cloudflare a Durable Object is single-threaded, which
 * gives the same guarantee.
 */
export class Database {
  private readonly engine: Engine;
  private depth = 0;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  run(sql: string, params: Params = []) {
    return this.engine.run(sql, params);
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    return this.engine.all(sql, params)[0] as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    return this.engine.all(sql, params) as T[];
  }

  exec(sql: string) {
    this.engine.exec(sql);
  }

  /** Run fn inside a write transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.depth = 1;
    try {
      return this.engine.transaction(fn);
    } finally {
      this.depth = 0;
    }
  }

  /** Allocate the next value of a named counter (inside the caller's transaction). */
  nextCounter(name: string): number {
    this.run('INSERT INTO counters(name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', [name]);
    this.run('UPDATE counters SET value = value + 1 WHERE name = ?', [name]);
    return this.get<{ value: number }>('SELECT value FROM counters WHERE name = ?', [name])!.value;
  }

  migrate(): number {
    this.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
    let count = 0;
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.exec(m.sql);
        this.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', [m.version, new Date().toISOString()]);
      });
      count++;
    }
    return count;
  }

  close() {
    this.engine.close();
  }
}
