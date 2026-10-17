import { AppError } from "../lib/errors.ts";

export type Row = Record<string, any>;
export type Value = string | number | null | ArrayBuffer;
/** Every application writer uses this revision, including outbox bookkeeping.
 * Reads are from primary. A changed revision aborts the ENTIRE D1 batch via
 * NOT NULL, then reruns validation. No external effects belong in the callback.
 */
export class Store {
  readonly d1: D1Database;
  constructor(db: D1Database) {
    this.d1 = db;
  }
  async get<T = Row>(
    sql: string,
    params: Value[] = [],
  ): Promise<T | undefined> {
    return (
      (await this.d1
        .withSession("first-primary")
        .prepare(sql)
        .bind(...params)
        .first<T>()) ?? undefined
    );
  }
  async all<T = Row>(sql: string, params: Value[] = []): Promise<T[]> {
    return (
      await this.d1
        .withSession("first-primary")
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
  }
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt)
        await new Promise((resolve) =>
          setTimeout(resolve, 5 + Math.random() * 30),
        );
      const revision = (await this.get<{ revision: number }>(
        "SELECT revision FROM app_revision WHERE id = 1",
      ))!.revision;
      const tx = new Transaction(this);
      let result: T;
      try {
        result = await fn(tx);
      } catch (error) {
        // A stale read must not cause a false domain error (e.g. bill changed).
        const current = (await this.get<{ revision: number }>(
          "SELECT revision FROM app_revision WHERE id=1",
        ))!.revision;
        if (current !== revision) continue;
        throw error;
      }
      if (!tx.statements.length) {
        if (
          (await this.get<{ revision: number }>(
            "SELECT revision FROM app_revision WHERE id=1",
          ))!.revision !== revision
        )
          continue;
        return result;
      }
      try {
        await this.d1.batch([
          this.d1
            .prepare(
              "UPDATE app_revision SET revision = CASE WHEN revision = ? THEN revision + 1 ELSE NULL END WHERE id = 1",
            )
            .bind(revision),
          ...tx.statements.map((s) => this.d1.prepare(s.sql).bind(...s.params)),
        ]);
        return result;
      } catch (error) {
        if (
          /NOT NULL constraint failed: app_revision.revision/.test(
            String(error),
          )
        )
          continue;
        throw error;
      }
    }
    throw new AppError(409, "BUSY", "The table is busy. Please retry.");
  }
}

export class Transaction {
  readonly statements: { sql: string; params: Value[] }[] = [];
  private ids = new Map<string, number>();
  private counters = new Map<string, number>();
  readonly db: Store;
  constructor(db: Store) {
    this.db = db;
  }
  get<T = Row>(sql: string, params: Value[] = []) {
    return this.db.get<T>(sql, params);
  }
  all<T = Row>(sql: string, params: Value[] = []) {
    return this.db.all<T>(sql, params);
  }
  run(sql: string, params: Value[] = []) {
    this.statements.push({ sql, params });
  }
  async id(table: string) {
    if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid table");
    const id =
      (this.ids.get(table) ??
        (await this.get<{ n: number }>(
          `SELECT COALESCE(MAX(id),0) AS n FROM ${table}`,
        ))!.n) + 1;
    this.ids.set(table, id);
    return id;
  }
  async counter(name: string) {
    const value =
      (this.counters.get(name) ??
        (
          await this.get<{ value: number }>(
            "SELECT value FROM counters WHERE name=?",
            [name],
          )
        )?.value ??
        0) + 1;
    this.counters.set(name, value);
    this.run(
      "INSERT INTO counters(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      [name, value],
    );
    return value;
  }
}
