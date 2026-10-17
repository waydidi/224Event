import type { Ctx } from '../context.ts';
import type { Database } from '../db/database.ts';
import { badRequest, conflict, gone } from '../lib/errors.ts';
import { padNumber, sha256 } from '../lib/ids.ts';
import { enqueue } from '../outbox/outbox.ts';
import type { CustomerAuth } from './access.ts';
import { createAction } from './actions.ts';
import { audit, type Actor } from './audit.ts';
import { menuReadiness, type MenuItemRow } from './menu.ts';
import { getSession, getTableById } from './tables.ts';

export const LIMITS = { maxLines: 18, maxQtyPerLine: 20, maxQtyPerOrder: 40, maxNoteLength: 200, maxItemNoteLength: 100 };

export interface OrderRow {
  id: number;
  order_number: string;
  session_id: number;
  status: 'NEW' | 'SERVED';
  notes: string | null;
  total_satang: number;
  created_at: string;
  served_at: string | null;
  served_by: number | null;
  serve_action_id: string | null;
}

export interface OrderItemRow {
  id: number;
  order_id: number;
  menu_item_id: number;
  item_name_snapshot: string;
  unit_price_satang: number;
  quantity: number;
  line_total_satang: number;
  /** Guest's note to staff for this drink, '' when none. */
  note: string;
}

export interface PlaceOrderInput {
  items: { menuItemId: number; quantity: number; note?: string }[];
  notes?: string | null;
  idempotencyKey: string;
  /** Total the customer saw; if prices changed in the meantime, the order is rejected for re-review. */
  expectedTotalSatang?: number;
}

export function normalize(input: unknown): { items: { menuItemId: number; quantity: number; note: string }[]; notes: string | null; idempotencyKey: string; expectedTotalSatang?: number } {
  const body = (input ?? {}) as Record<string, unknown>;
  const key = body.idempotencyKey;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Missing or invalid idempotency key');
  if (!Array.isArray(body.items) || body.items.length === 0) throw badRequest('EMPTY_ORDER', 'Your order is empty');
  // Same drink + same note merge into one line; the same drink with a different note stays a separate line.
  const merged = new Map<string, { menuItemId: number; quantity: number; note: string }>();
  for (const raw of body.items as unknown[]) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const id = it.menuItemId;
    const qty = it.quantity;
    if (!Number.isSafeInteger(id) || (id as number) <= 0) throw badRequest('INVALID_ITEM', 'Invalid menu item');
    if (!Number.isSafeInteger(qty) || (qty as number) < 1 || (qty as number) > LIMITS.maxQtyPerLine) {
      throw badRequest('INVALID_QUANTITY', `Quantity must be between 1 and ${LIMITS.maxQtyPerLine}`);
    }
    let note = '';
    if (it.note !== undefined && it.note !== null) {
      if (typeof it.note !== 'string') throw badRequest('INVALID_NOTES', 'Invalid note');
      note = it.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (note.length > LIMITS.maxItemNoteLength) throw badRequest('NOTES_TOO_LONG', `A drink note must be at most ${LIMITS.maxItemNoteLength} characters`);
    }
    const mergeKey = `${id}\u0000${note}`;
    const prev = merged.get(mergeKey);
    merged.set(mergeKey, { menuItemId: id as number, note, quantity: (prev?.quantity ?? 0) + (qty as number) });
  }
  if (merged.size > LIMITS.maxLines) throw badRequest('TOO_MANY_ITEMS', 'Too many different items in one order');
  const items = [...merged.values()].sort((a, b) => a.menuItemId - b.menuItemId || a.note.localeCompare(b.note));
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  if (items.some((i) => i.quantity > LIMITS.maxQtyPerLine) || totalQty > LIMITS.maxQtyPerOrder) {
    throw badRequest('TOO_MANY_DRINKS', `Please order at most ${LIMITS.maxQtyPerOrder} drinks at a time (max ${LIMITS.maxQtyPerLine} of one kind)`);
  }
  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') throw badRequest('INVALID_NOTES', 'Invalid note');
    // Strip control characters; keep the note short.
    notes = body.notes.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || null;
    if (notes && notes.length > LIMITS.maxNoteLength) throw badRequest('NOTES_TOO_LONG', `Note must be at most ${LIMITS.maxNoteLength} characters`);
  }
  let expectedTotalSatang: number | undefined;
  if (body.expectedTotalSatang !== undefined && body.expectedTotalSatang !== null) {
    if (!Number.isSafeInteger(body.expectedTotalSatang)) throw badRequest('INVALID_TOTAL', 'Invalid expected total');
    expectedTotalSatang = body.expectedTotalSatang as number;
  }
  return { items, notes, idempotencyKey: key, expectedTotalSatang };
}

export function placeOrder(ctx: Ctx, auth: CustomerAuth, rawInput: unknown): { order: OrderRow; items: OrderItemRow[]; replayed: boolean } {
  const input = normalize(rawInput);
  const requestHash = sha256(JSON.stringify({ items: input.items, notes: input.notes }));

  const result = ctx.db.tx(() => {
    // Re-read authoritative state inside the write transaction.
    const session = getSession(ctx.db, auth.session.id)!;
    const table = getTableById(ctx.db, session.table_id);

    const existing = ctx.db.get<OrderRow & { request_hash: string }>('SELECT * FROM orders WHERE session_id = ? AND idempotency_key = ?', [
      session.id, input.idempotencyKey,
    ]);
    if (existing) {
      if (existing.request_hash !== requestHash) throw conflict('IDEMPOTENCY_MISMATCH', 'This order was already submitted with different contents');
      return { order: existing, items: orderItems(ctx.db, existing.id), replayed: true };
    }

    if (table.current_session_id !== session.id || session.status === 'PAID_CLOSED' || session.status === 'VOIDED') {
      throw gone('SESSION_ENDED', `Session ${session.session_code} has ended.`);
    }
    if (session.status === 'PAYMENT_REQUESTED') {
      throw conflict('PAYMENT_REQUESTED', 'Payment has been requested for this table, so new orders are paused. Ask staff if you would like to add more.');
    }
    const readiness = menuReadiness(ctx.db);
    if (!readiness.ready) throw conflict('MENU_NOT_READY', 'Ordering is not open yet. Please ask staff.');

    const lines: Omit<OrderItemRow, 'id' | 'order_id'>[] = [];
    for (const { menuItemId, quantity, note } of input.items) {
      const item = ctx.db.get<MenuItemRow>('SELECT * FROM menu_items WHERE id = ?', [menuItemId]);
      if (!item) throw badRequest('INVALID_ITEM', 'Invalid menu item');
      if (!item.available) throw conflict('ITEM_UNAVAILABLE', `${item.name} is currently unavailable`, { menuItemId });
      const unit = item.price_satang!;
      lines.push({ menu_item_id: item.id, item_name_snapshot: item.name, unit_price_satang: unit, quantity, line_total_satang: unit * quantity, note });
    }
    const total = lines.reduce((s, l) => s + l.line_total_satang, 0);
    if (input.expectedTotalSatang !== undefined && input.expectedTotalSatang !== total) {
      throw conflict('PRICE_CHANGED', 'Prices have changed. Please review your cart.', { totalSatang: total });
    }

    const orderNumber = padNumber('ORD-', ctx.db.nextCounter('order'), 4);
    const now = ctx.now().toISOString();
    const res = ctx.db.run(
      `INSERT INTO orders(order_number, session_id, status, notes, total_satang, created_at, idempotency_key, request_hash)
       VALUES (?, ?, 'NEW', ?, ?, ?, ?, ?)`,
      [orderNumber, session.id, input.notes, total, now, input.idempotencyKey, requestHash],
    );
    const orderId = Number(res.lastInsertRowid);
    for (const l of lines) {
      ctx.db.run(
        'INSERT INTO order_items(order_id, menu_item_id, item_name_snapshot, unit_price_satang, quantity, line_total_satang, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [orderId, l.menu_item_id, l.item_name_snapshot, l.unit_price_satang, l.quantity, l.line_total_satang, l.note],
      );
    }
    const actionId = createAction(ctx, 'order.serve', 'order', orderId);
    ctx.db.run('UPDATE orders SET serve_action_id = ? WHERE id = ?', [actionId, orderId]);
    audit(ctx, { type: 'customer', accessId: auth.access.id }, 'order.create', 'order', orderId, { orderNumber, total, session: session.session_code });
    enqueue(ctx, 'telegram.order_card', { orderId }, `order_card:new:${orderId}`);
    const order = ctx.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId])!;
    return { order, items: orderItems(ctx.db, orderId), replayed: false };
  });
  if (!result.replayed) ctx.kick();
  return result;
}

/** Idempotent: a second tap on an already-served order changes nothing. */
export function markServed(ctx: Ctx, orderId: number, actor: Actor & { type: 'staff' }) {
  const result = ctx.db.tx(() => {
    const order = ctx.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) throw badRequest('ORDER_NOT_FOUND', 'Order not found');
    if (order.status === 'SERVED') return { changed: false, order };
    const session = getSession(ctx.db, order.session_id)!;
    if (session.status === 'PAID_CLOSED' || session.status === 'VOIDED') {
      throw conflict('SESSION_CLOSED', `Session ${session.session_code} is closed; it can no longer be modified.`);
    }
    const now = ctx.now().toISOString();
    const res = ctx.db.run("UPDATE orders SET status = 'SERVED', served_at = ?, served_by = ? WHERE id = ? AND status = 'NEW'", [now, actor.staff.id, orderId]);
    if (Number(res.changes) !== 1) return { changed: false, order };
    audit(ctx, actor, 'order.served', 'order', orderId, { orderNumber: order.order_number });
    enqueue(ctx, 'telegram.order_card', { orderId }, `order_card:served:${orderId}`);
    return { changed: true, order: ctx.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId])! };
  });
  if (result.changed) ctx.kick();
  return result;
}

export function orderItems(db: Database, orderId: number) {
  return db.all<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
}

export function sessionOrders(db: Database, sessionId: number) {
  const orders = db.all<OrderRow>('SELECT * FROM orders WHERE session_id = ? ORDER BY id', [sessionId]);
  return orders.map((o) => ({ ...o, items: orderItems(db, o.id) }));
}
