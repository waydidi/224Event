import type { Config } from '../config.ts';
import type { Ctx } from '../context.ts';
import type { Database } from '../db/database.ts';
import { badRequest, conflict, gone } from '../lib/errors.ts';
import { applyBps, formatBaht } from '../lib/money.ts';
import { padNumber } from '../lib/ids.ts';
import { enqueue } from '../outbox/outbox.ts';
import type { CustomerAuth } from './access.ts';
import { createAction } from './actions.ts';
import { audit, type Actor } from './audit.ts';
import { sessionOrders } from './orders.ts';
import { getActiveSession, getSession, getTableById, getTableByNumber, type SessionRow } from './tables.ts';

export interface Adjustment {
  label: string;
  bps: number;
  amountSatang: number;
}

export interface BillLine {
  orderId: number;
  orderNumber: string;
  itemName: string;
  unitPriceSatang: number;
  quantity: number;
  lineTotalSatang: number;
}

export interface BillView {
  status: 'DRAFT' | 'REQUESTED' | 'PAID' | 'CANCELLED';
  billId: number | null;
  billNumber: string | null;
  version: number | null;
  sessionCode: string;
  orderNumbers: string[];
  lines: BillLine[];
  subtotalSatang: number;
  adjustments: Adjustment[];
  totalSatang: number;
  requestedAt: string | null;
  paidAt: string | null;
}

export interface BillRow {
  id: number;
  bill_number: string;
  session_id: number;
  version: number;
  subtotal_satang: number;
  adjustments_satang: number;
  adjustments_json: string;
  total_satang: number;
  status: 'REQUESTED' | 'PAID' | 'CANCELLED';
  requested_at: string;
  cancelled_at: string | null;
  cancelled_by: number | null;
  paid_at: string | null;
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/** Only explicitly configured charges are applied; nothing is invented. */
export function computeAdjustments(config: Config, subtotal: number): Adjustment[] {
  const out: Adjustment[] = [];
  let base = subtotal;
  if (config.billing.serviceChargeBps > 0) {
    const amt = applyBps(subtotal, config.billing.serviceChargeBps);
    out.push({ label: `Service charge ${pct(config.billing.serviceChargeBps)}`, bps: config.billing.serviceChargeBps, amountSatang: amt });
    base += amt;
  }
  if (config.billing.vatBps > 0) {
    out.push({ label: `VAT ${pct(config.billing.vatBps)}`, bps: config.billing.vatBps, amountSatang: applyBps(base, config.billing.vatBps) });
  }
  return out;
}

/** Live (unfrozen) bill computed from every order in the session. */
export function draftBill(db: Database, config: Config, session: SessionRow): BillView {
  const orders = sessionOrders(db, session.id);
  const lines: BillLine[] = orders.flatMap((o) =>
    o.items.map((i) => ({
      orderId: o.id,
      orderNumber: o.order_number,
      itemName: i.item_name_snapshot,
      unitPriceSatang: i.unit_price_satang,
      quantity: i.quantity,
      lineTotalSatang: i.line_total_satang,
    })),
  );
  const subtotal = lines.reduce((s, l) => s + l.lineTotalSatang, 0);
  const adjustments = computeAdjustments(config, subtotal);
  return {
    status: 'DRAFT', billId: null, billNumber: null, version: null, sessionCode: session.session_code,
    orderNumbers: orders.map((o) => o.order_number), lines, subtotalSatang: subtotal, adjustments,
    totalSatang: subtotal + adjustments.reduce((s, a) => s + a.amountSatang, 0), requestedAt: null, paidAt: null,
  };
}

export function getBill(db: Database, billId: number) {
  return db.get<BillRow>('SELECT * FROM bills WHERE id = ?', [billId]);
}

export function frozenBillView(db: Database, bill: BillRow): BillView {
  const session = getSession(db, bill.session_id)!;
  const lines = db.all<{ order_id: number; order_number: string; item_name: string; unit_price_satang: number; quantity: number; line_total_satang: number }>(
    'SELECT * FROM bill_lines WHERE bill_id = ? ORDER BY id', [bill.id],
  ).map((l) => ({
    orderId: l.order_id, orderNumber: l.order_number, itemName: l.item_name,
    unitPriceSatang: l.unit_price_satang, quantity: l.quantity, lineTotalSatang: l.line_total_satang,
  }));
  return {
    status: bill.status, billId: bill.id, billNumber: bill.bill_number, version: bill.version, sessionCode: session.session_code,
    orderNumbers: [...new Set(lines.map((l) => l.orderNumber))], lines, subtotalSatang: bill.subtotal_satang,
    adjustments: JSON.parse(bill.adjustments_json), totalSatang: bill.total_satang, requestedAt: bill.requested_at, paidAt: bill.paid_at,
  };
}

/** The bill a customer should see right now for their session. */
export function currentBillView(db: Database, config: Config, session: SessionRow): BillView {
  if (session.status === 'OPEN' || session.status === 'VOIDED') return draftBill(db, config, session);
  const bill = db.get<BillRow>('SELECT * FROM bills WHERE session_id = ? AND version = ?', [session.id, session.bill_version]);
  return bill ? frozenBillView(db, bill) : draftBill(db, config, session);
}

/**
 * OPEN -> PAYMENT_REQUESTED. Freezes the bill (new version + snapshot lines) and
 * stops new orders, atomically. The customer must confirm the total they
 * reviewed; if another guest ordered in between, they are asked to re-review.
 */
export function requestPayment(ctx: Ctx, auth: CustomerAuth, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Number.isSafeInteger(b.expectedTotalSatang) || !Number.isSafeInteger(b.expectedOrderCount)) {
    throw badRequest('INVALID_REQUEST', 'Please review the bill first');
  }
  const result = ctx.db.tx(() => {
    const session = getSession(ctx.db, auth.session.id)!;
    const table = getTableById(ctx.db, session.table_id);
    if (table.current_session_id !== session.id || session.status === 'PAID_CLOSED' || session.status === 'VOIDED') {
      throw gone('SESSION_ENDED', `Session ${session.session_code} has ended.`);
    }
    if (session.status === 'PAYMENT_REQUESTED') {
      // Double tap / second guest: the request already exists.
      const bill = ctx.db.get<BillRow>('SELECT * FROM bills WHERE session_id = ? AND version = ?', [session.id, session.bill_version])!;
      return { bill: frozenBillView(ctx.db, bill), created: false };
    }
    const draft = draftBill(ctx.db, ctx.config, session);
    if (draft.lines.length === 0) throw conflict('NOTHING_TO_PAY', 'There are no orders on this table yet.');
    if (draft.totalSatang !== b.expectedTotalSatang || draft.orderNumbers.length !== b.expectedOrderCount) {
      throw conflict('BILL_CHANGED', 'The bill has changed since you opened it. Please review it again.', { totalSatang: draft.totalSatang });
    }
    const version = session.bill_version + 1;
    const now = ctx.now().toISOString();
    const adjustmentsTotal = draft.adjustments.reduce((s, a) => s + a.amountSatang, 0);
    const billNumber = padNumber('BILL-', ctx.db.nextCounter('bill'), 4);
    const res = ctx.db.run(
      `INSERT INTO bills(bill_number, session_id, version, subtotal_satang, adjustments_satang, adjustments_json, total_satang, status, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?)`,
      [billNumber, session.id, version, draft.subtotalSatang, adjustmentsTotal, JSON.stringify(draft.adjustments), draft.totalSatang, now],
    );
    const billId = Number(res.lastInsertRowid);
    for (const l of draft.lines) {
      ctx.db.run(
        'INSERT INTO bill_lines(bill_id, order_id, order_number, item_name, unit_price_satang, quantity, line_total_satang) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [billId, l.orderId, l.orderNumber, l.itemName, l.unitPriceSatang, l.quantity, l.lineTotalSatang],
      );
    }
    const upd = ctx.db.run("UPDATE table_sessions SET status = 'PAYMENT_REQUESTED', bill_version = ? WHERE id = ? AND status = 'OPEN'", [version, session.id]);
    if (Number(upd.changes) !== 1) throw conflict('SESSION_STATE_CHANGED', 'Please try again.');
    for (const method of ctx.config.billing.paymentMethods) createAction(ctx, 'payment.confirm', 'bill', billId, { method });
    createAction(ctx, 'bill.reopen', 'bill', billId);
    audit(ctx, { type: 'customer', accessId: auth.access.id }, 'bill.request_payment', 'bill', billId, {
      billNumber, version, total: draft.totalSatang, session: session.session_code,
    });
    enqueue(ctx, 'telegram.payment_card', { billId }, `payment_card:new:${billId}`);
    return { bill: frozenBillView(ctx.db, getBill(ctx.db, billId)!), created: true };
  });
  if (result.created) ctx.kick();
  return result;
}

/**
 * PAYMENT_REQUESTED -> OPEN (authorized staff). Cancels the frozen bill so the
 * guests can add drinks; the next request creates a fresh bill version.
 */
export function reopenBill(ctx: Ctx, target: { billId: number } | { tableNumber: number }, actor: Actor & { type: 'staff' }) {
  const result = ctx.db.tx(() => {
    let bill: BillRow | undefined;
    if ('billId' in target) bill = getBill(ctx.db, target.billId);
    else {
      const table = getTableByNumber(ctx.db, target.tableNumber);
      const s = table && getActiveSession(ctx.db, table);
      bill = s ? ctx.db.get<BillRow>("SELECT * FROM bills WHERE session_id = ? AND status = 'REQUESTED'", [s.id]) : undefined;
    }
    if (!bill) throw conflict('NO_PENDING_BILL', 'There is no pending bill to reopen.');
    if (bill.status === 'CANCELLED') return { changed: false, bill };
    if (bill.status === 'PAID') throw conflict('BILL_PAID', `${bill.bill_number} is already paid and cannot be reopened.`);
    const session = getSession(ctx.db, bill.session_id)!;
    if (session.status !== 'PAYMENT_REQUESTED' || session.bill_version !== bill.version) {
      throw conflict('BILL_STALE', 'This bill is no longer the active bill for the table.');
    }
    const now = ctx.now().toISOString();
    ctx.db.run("UPDATE bills SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ? WHERE id = ?", [now, actor.staff.id, bill.id]);
    ctx.db.run("UPDATE table_sessions SET status = 'OPEN' WHERE id = ?", [session.id]);
    audit(ctx, actor, 'bill.reopen', 'bill', bill.id, { billNumber: bill.bill_number, total: formatBaht(bill.total_satang), session: session.session_code });
    enqueue(ctx, 'telegram.payment_card', { billId: bill.id }, `payment_card:cancelled:${bill.id}`);
    return { changed: true, bill: getBill(ctx.db, bill.id)! };
  });
  if (result.changed) ctx.kick();
  return result;
}
