import type { Ctx } from '../context.ts';
import type { Database } from '../db/database.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { escapeHtml } from '../lib/html.ts';
import { randomPin, randomToken } from '../lib/ids.ts';
import { enqueue } from '../outbox/outbox.ts';
import { createAction } from './actions.ts';
import { audit, type Actor } from './audit.ts';

export type SessionStatus = 'OPEN' | 'PAYMENT_REQUESTED' | 'PAID_CLOSED' | 'VOIDED';

export interface TableRow {
  id: number;
  display_number: number;
  name: string | null;
  permanent_qr_token: string;
  current_session_id: number | null;
  status: 'AVAILABLE' | 'OCCUPIED';
}

export interface SessionRow {
  id: number;
  table_id: number;
  round_number: number;
  session_code: string;
  status: SessionStatus;
  join_pin: string;
  pin_failed_attempts: number;
  opened_at: string;
  opened_by: number | null;
  closed_at: string | null;
  bill_version: number;
}

export const ACTIVE_STATUSES: SessionStatus[] = ['OPEN', 'PAYMENT_REQUESTED'];

export const sessionCode = (tableNumber: number, round: number) => `TABLE${tableNumber}-${round}`;

export function getTableByNumber(db: Database, n: number) {
  return db.get<TableRow>('SELECT * FROM tables WHERE display_number = ?', [n]);
}

export function getTableByQrToken(db: Database, token: string) {
  return db.get<TableRow>('SELECT * FROM tables WHERE permanent_qr_token = ?', [token]);
}

export function getTableById(db: Database, id: number) {
  return db.get<TableRow>('SELECT * FROM tables WHERE id = ?', [id])!;
}

export function getSession(db: Database, id: number) {
  return db.get<SessionRow>('SELECT * FROM table_sessions WHERE id = ?', [id]);
}

/** The table's current session, if it is still active (OPEN or PAYMENT_REQUESTED). */
export function getActiveSession(db: Database, table: TableRow): SessionRow | undefined {
  if (!table.current_session_id) return undefined;
  const s = getSession(db, table.current_session_id);
  return s && ACTIVE_STATUSES.includes(s.status) ? s : undefined;
}

export function listTables(db: Database) {
  return db.all<TableRow & { session_code: string | null; session_status: SessionStatus | null; join_pin: string | null; last_round: number | null }>(
    `SELECT t.*, s.session_code, s.status AS session_status, s.join_pin,
            (SELECT MAX(round_number) FROM table_sessions WHERE table_id = t.id) AS last_round
     FROM tables t LEFT JOIN table_sessions s ON s.id = t.current_session_id
     ORDER BY t.display_number`,
  );
}

export function nextSessionCode(db: Database, table: TableRow): string {
  const r = db.get<{ m: number | null }>('SELECT MAX(round_number) AS m FROM table_sessions WHERE table_id = ?', [table.id]);
  return sessionCode(table.display_number, (r?.m ?? 0) + 1);
}

/** Provision tables 1..count (idempotent). Each gets a permanent, non-guessable QR token. */
export function ensureTables(ctx: Ctx, count: number): TableRow[] {
  return ctx.db.tx(() => {
    for (let n = 1; n <= count; n++) {
      if (getTableByNumber(ctx.db, n)) continue;
      ctx.db.run('INSERT INTO tables(display_number, name, permanent_qr_token, status, created_at) VALUES (?, ?, ?, ?, ?)', [
        n, `Table ${n}`, randomToken(12), 'AVAILABLE', ctx.now().toISOString(),
      ]);
      audit(ctx, { type: 'system' }, 'table.create', 'table', n);
    }
    return ctx.db.all<TableRow>('SELECT * FROM tables ORDER BY display_number');
  });
}

function requireTable(db: Database, n: number) {
  const t = getTableByNumber(db, n);
  if (!t) throw notFound('TABLE_NOT_FOUND', `Table ${n} does not exist`);
  return t;
}

function announceSession(ctx: Ctx, session: SessionRow, table: TableRow, heading: string, staffName: string) {
  const pinAction = createAction(ctx, 'table.pin', 'table', table.display_number);
  enqueue(ctx, 'telegram.text', {
    kind: 'session_opened',
    text:
      `🟢 <b>${heading}</b>\n` +
      `Table: ${table.display_number}\nSession: ${session.session_code}\n` +
      `Join PIN: <code>${session.join_pin}</code>\n` +
      `By: ${escapeHtml(staffName)}\n\nGive the PIN only to the guests seated at this table.`,
    buttons: [[{ text: '🔁 New PIN', actionId: pinAction }]],
  });
}

/**
 * Open the next round for a table. The round number is allocated inside the
 * write transaction and guarded by UNIQUE(table_id, round_number) plus the
 * partial unique index allowing only one active session per table.
 */
export function openSession(ctx: Ctx, tableNumber: number, actor: Actor & { type: 'staff' }): SessionRow {
  const session = ctx.db.tx(() => {
    const table = requireTable(ctx.db, tableNumber);
    const active = getActiveSession(ctx.db, table);
    if (active) throw conflict('TABLE_ALREADY_OPEN', `Table ${tableNumber} already has active session ${active.session_code} (${active.status})`);
    const last = ctx.db.get<{ m: number | null }>('SELECT MAX(round_number) AS m FROM table_sessions WHERE table_id = ?', [table.id]);
    const round = (last?.m ?? 0) + 1;
    const now = ctx.now().toISOString();
    const res = ctx.db.run(
      `INSERT INTO table_sessions(table_id, round_number, session_code, status, join_pin, opened_at, opened_by)
       VALUES (?, ?, ?, 'OPEN', ?, ?, ?)`,
      [table.id, round, sessionCode(table.display_number, round), randomPin(ctx.config.access.pinLength), now, actor.staff.id],
    );
    const id = Number(res.lastInsertRowid);
    ctx.db.run("UPDATE tables SET status = 'OCCUPIED', current_session_id = ? WHERE id = ?", [id, table.id]);
    const session = getSession(ctx.db, id)!;
    audit(ctx, actor, 'session.open', 'session', id, { table: table.display_number, code: session.session_code });
    announceSession(ctx, session, table, `TABLE ${table.display_number} OPENED`, actor.staff.display_name);
    // Refresh the previous round's paid card so its "Open next session" button disappears.
    const prevBill = ctx.db.get<{ id: number }>(
      `SELECT b.id FROM bills b JOIN table_sessions s ON s.id = b.session_id
       WHERE s.table_id = ? AND b.status = 'PAID' ORDER BY b.id DESC LIMIT 1`,
      [table.id],
    );
    if (prevBill) enqueue(ctx, 'telegram.payment_card', { billId: prevBill.id });
    return session;
  });
  ctx.kick();
  return session;
}

/** Rotate the join PIN of the active session (also clears a PIN lockout). Existing guests stay joined. */
export function rotatePin(ctx: Ctx, tableNumber: number, actor: Actor & { type: 'staff' }): SessionRow {
  const session = ctx.db.tx(() => {
    const table = requireTable(ctx.db, tableNumber);
    const active = getActiveSession(ctx.db, table);
    if (!active) throw conflict('NO_ACTIVE_SESSION', `Table ${tableNumber} has no active session`);
    ctx.db.run('UPDATE table_sessions SET join_pin = ?, pin_failed_attempts = 0 WHERE id = ?', [randomPin(ctx.config.access.pinLength), active.id]);
    const s = getSession(ctx.db, active.id)!;
    audit(ctx, actor, 'session.pin_rotate', 'session', s.id);
    announceSession(ctx, s, table, `NEW PIN · TABLE ${table.display_number}`, actor.staff.display_name);
    return s;
  });
  ctx.kick();
  return session;
}

/**
 * Deliberate, audited recovery path: end an active session without payment.
 * Orders are preserved; any pending bill is cancelled. Never applies to paid sessions.
 */
export function voidSession(ctx: Ctx, tableNumber: number, actor: Extract<Actor, { type: 'staff' | 'system' }>, opts: { onlyIfEmpty: boolean; reason: string }) {
  const result = ctx.db.tx(() => {
    const table = requireTable(ctx.db, tableNumber);
    const active = getActiveSession(ctx.db, table);
    if (!active) throw conflict('NO_ACTIVE_SESSION', `Table ${tableNumber} has no active session`);
    const orderCount = ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM orders WHERE session_id = ?', [active.id])!.c;
    if (opts.onlyIfEmpty && orderCount > 0) {
      throw conflict('SESSION_HAS_ORDERS', `${active.session_code} has ${orderCount} order(s). Confirm payment, or a lead can /void_table ${tableNumber} CONFIRM.`);
    }
    const now = ctx.now().toISOString();
    const bill = ctx.db.get<{ id: number }>("SELECT id FROM bills WHERE session_id = ? AND status = 'REQUESTED'", [active.id]);
    if (bill) {
      ctx.db.run("UPDATE bills SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ? WHERE id = ?", [now, actor.type === 'staff' ? actor.staff.id : null, bill.id]);
      enqueue(ctx, 'telegram.payment_card', { billId: bill.id });
    }
    ctx.db.run("UPDATE table_sessions SET status = 'VOIDED', closed_at = ? WHERE id = ?", [now, active.id]);
    ctx.db.run("UPDATE tables SET status = 'AVAILABLE', current_session_id = NULL WHERE id = ?", [table.id]);
    audit(ctx, actor, opts.onlyIfEmpty ? 'session.close_empty' : 'session.void', 'session', active.id, { reason: opts.reason, orderCount, cancelledBill: bill?.id ?? null });
    return { session: getSession(ctx.db, active.id)!, orderCount, next: nextSessionCode(ctx.db, table) };
  });
  ctx.kick();
  return result;
}

const ARRIVAL_COOLDOWN_MS = 10 * 60_000;

/**
 * A guest scanned a table's QR code while no session is open: tell the staff group, with a one-tap
 * "Open table" button. At most one notice per table per 10 minutes, however many guests scan or reload.
 */
export function notifyTableWaiting(ctx: Ctx, table: TableRow): { notified: boolean } {
  if (getActiveSession(ctx.db, table)) return { notified: false };
  const bucket = Math.floor(ctx.now().getTime() / ARRIVAL_COOLDOWN_MS);
  const queued = ctx.db.tx(() => {
    const before = ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM outbox_events WHERE dedupe_key = ?', [`table.waiting:${table.id}:${bucket}`])!.c;
    if (before) return false;
    const openAction = createAction(ctx, 'table.open', 'table', table.display_number, { tableNumber: table.display_number });
    enqueue(ctx, 'telegram.text', {
      kind: 'table_waiting',
      text: `📲 <b>Table ${table.display_number}</b> scanned the QR code and is waiting for staff.\nTap to open the table and get the PIN for the guests.`,
      buttons: [[{ text: `✅ Open table ${table.display_number}`, actionId: openAction }]],
    }, `table.waiting:${table.id}:${bucket}`);
    return true;
  });
  if (queued) ctx.kick();
  return { notified: queued };
}
