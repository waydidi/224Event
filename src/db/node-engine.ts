import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database, type Engine, type Params, type Row } from './database.ts';

class NodeEngine implements Engine {
  private readonly raw: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  run(sql: string, params: Params) {
    return this.raw.prepare(sql).run(...params);
  }

  all(sql: string, params: Params) {
    return this.raw.prepare(sql).all(...params) as Row[];
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.raw.close();
  }
}

/** File-backed (or ":memory:") database for local development, tests and the operator CLI. */
export class NodeDatabase extends Database {
  constructor(file: string) {
    super(new NodeEngine(file));
  }
}
