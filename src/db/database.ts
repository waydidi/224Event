import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrations } from './migrations.ts';

export type Params = Record<string, SQLInputValue> | SQLInputValue[];
export type Row = Record<string, any>;

/**
 * Thin synchronous wrapper around node:sqlite.
 *
 * SQLite runs in-process and every statement is synchronous, so a transaction
 * started with BEGIN IMMEDIATE holds the write lock for its whole (synchronous)
 * body: payment request, payment confirmation and session rollover are fully
 * serialized without explicit row locks.
 */
export class Database {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
  }

  run(sql: string, params: Params = []) {
    const stmt = this.raw.prepare(sql);
    return Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
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
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
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
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
    let count = 0;
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', [m.version, new Date().toISOString()]);
      });
      count++;
    }
    return count;
  }

  close() {
    this.raw.close();
  }
}
