import type { Ctx } from '../context.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { padNumber, randomToken } from '../lib/ids.ts';
import { enqueue } from '../outbox/outbox.ts';
import { createAction } from './actions.ts';
import { audit, type Actor } from './audit.ts';
import { getBill } from './billing.ts';
import { getSession, getTableById, nextSessionCode } from './tables.ts';

export interface PaymentRow {
  id: number;
  bill_id: number;
  amount_satang: number;
  method: string;
  status: 'CONFIRMED';
  confirmed_by: number;
  confirmed_at: string;
  idempotency_key: string;
}

/**
 * Authorized cashier confirms that money was collected (externally) for a
 * frozen bill. Atomically: record exactly one payment, mark the bill PAID,
 * close the session, free the table and queue the receipt. Repeated taps are
 * no-ops (bill-scoped idempotency key + unique index on payments.bill_id).
 */
export function confirmPayment(ctx: Ctx, billId: number, method: string, actor: Actor & { type: 'staff' }) {
  if (!ctx.config.billing.paymentMethods.includes(method)) throw badRequest('INVALID_METHOD', `Unknown payment method ${method}`);
  const result = ctx.db.tx(() => {
    const bill = getBill(ctx.db, billId);
    if (!bill) throw badRequest('BILL_NOT_FOUND', 'Bill not found');
    const existing = ctx.db.get<PaymentRow>("SELECT * FROM payments WHERE bill_id = ? AND status = 'CONFIRMED'", [bill.id]);
    if (existing) return { changed: false, payment: existing, bill };
    if (bill.status !== 'REQUESTED') throw conflict('BILL_NOT_PAYABLE', `${bill.bill_number} is ${bill.status.toLowerCase()} and cannot be paid.`);

    const session = getSession(ctx.db, bill.session_id)!;
    if (session.status !== 'PAYMENT_REQUESTED' || session.bill_version !== bill.version) {
      throw conflict('BILL_STALE', 'This bill is no longer the active bill for the table.');
    }
    // Integrity: the frozen lines must add up to the frozen totals.
    const sum = ctx.db.get<{ s: number }>('SELECT COALESCE(SUM(line_total_satang), 0) AS s FROM bill_lines WHERE bill_id = ?', [bill.id])!.s;
    if (sum !== bill.subtotal_satang || bill.subtotal_satang + bill.adjustments_satang !== bill.total_satang) {
      throw conflict('BILL_INTEGRITY', 'Bill totals do not match its lines; payment not recorded.');
    }

    const now = ctx.now().toISOString();
    const res = ctx.db.run(
      `INSERT INTO payments(bill_id, amount_satang, method, status, confirmed_by, confirmed_at, idempotency_key)
       VALUES (?, ?, ?, 'CONFIRMED', ?, ?, ?)`,
      [bill.id, bill.total_satang, method, actor.staff.id, now, `bill:${bill.id}`],
    );
    const paymentId = Number(res.lastInsertRowid);
    ctx.db.run("UPDATE bills SET status = 'PAID', paid_at = ? WHERE id = ? AND status = 'REQUESTED'", [now, bill.id]);
    ctx.db.run("UPDATE table_sessions SET status = 'PAID_CLOSED', closed_at = ? WHERE id = ?", [now, session.id]);
    const table = getTableById(ctx.db, session.table_id);
    ctx.db.run("UPDATE tables SET status = 'AVAILABLE', current_session_id = NULL WHERE id = ? AND current_session_id = ?", [table.id, session.id]);

    createAction(ctx, 'table.open', 'bill', bill.id, { tableNumber: table.display_number });
    const receiptNumber = padNumber('R-', ctx.db.nextCounter('receipt'), 6);
    const rr = ctx.db.run('INSERT INTO receipts(payment_id, receipt_number, lookup_token, width_mm) VALUES (?, ?, ?, ?)', [
      paymentId, receiptNumber, randomToken(24), ctx.config.receipt.widthMm,
    ]);
    const receiptId = Number(rr.lastInsertRowid);

    audit(ctx, actor, 'payment.confirm', 'bill', bill.id, {
      paymentId, amount: bill.total_satang, method, session: session.session_code, receiptNumber,
    });
    audit(ctx, actor, 'session.close', 'session', session.id, { status: 'PAID_CLOSED', next: nextSessionCode(ctx.db, table) });
    enqueue(ctx, 'telegram.payment_card', { billId: bill.id }, `payment_card:paid:${bill.id}`);
    enqueue(ctx, 'receipt.generate', { receiptId, send: true }, `receipt:generate:${receiptId}`);
    return { changed: true, payment: ctx.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', [paymentId])!, bill: getBill(ctx.db, bill.id)! };
  });
  if (result.changed) ctx.kick();
  return result;
}
