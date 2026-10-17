import { Database, type Engine, type Params, type Row } from './database.ts';

/** The slice of Cloudflare's Durable Object SQLite API that we use. */
export interface DoSqlStorage {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}
export interface DoStorage {
  sql: DoSqlStorage;
  transactionSync<T>(fn: () => T): T;
}

class DoEngine implements Engine {
  private readonly storage: DoStorage;

  constructor(storage: DoStorage) {
    this.storage = storage;
  }

  exec(sql: string) {
    this.storage.sql.exec(sql);
  }

  run(sql: string, params: Params) {
    this.storage.sql.exec(sql, ...params);
    const r = this.storage.sql.exec('SELECT changes() AS c, last_insert_rowid() AS r').toArray()[0] as { c: number; r: number };
    return { changes: r.c, lastInsertRowid: r.r };
  }

  all(sql: string, params: Params) {
    return this.storage.sql.exec(sql, ...params).toArray().map(normalizeRow);
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  close() {}
}

/** BLOB columns come back as ArrayBuffer on Cloudflare; the rest of the app expects Uint8Array. */
function normalizeRow(row: unknown): Row {
  const out = row as Row;
  for (const k of Object.keys(out)) if (out[k] instanceof ArrayBuffer) out[k] = new Uint8Array(out[k]);
  return out;
}

/** Database stored inside a Durable Object (SQLite-backed). */
export class DurableObjectDatabase extends Database {
  constructor(storage: DoStorage) {
    super(new DoEngine(storage));
  }
}
