import type { Config } from '../config.ts';
import type { Database } from '../db/database.ts';
import { findActionsFor } from '../domain/actions.ts';
import { frozenBillView, getBill } from '../domain/billing.ts';
import { orderItems, type OrderRow } from '../domain/orders.ts';
import { getSession, getTableById, nextSessionCode } from '../domain/tables.ts';
import { escapeHtml } from '../lib/html.ts';
import { formatBaht } from '../lib/money.ts';
import { formatTime } from '../lib/time.ts';

export interface Card {
  text: string;
  buttons: { text: string; actionId: string }[][];
}

const WIDTH = 30;

/** A drink's note under its line in the monospace block: "  ↳ less ice", wrapped to the card width. */
export function noteLines(note: string, width = WIDTH): string[] {
  if (!note) return [];
  const room = width - 4;
  const out: string[] = [];
  let cur = '';
  for (const word of note.split(' ')) {
    for (let w = word; w.length > 0; w = w.slice(room)) {
      const piece = w.slice(0, room);
      if (cur && (cur + ' ' + piece).length > room) { out.push(cur); cur = piece; } else cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out.map((l, i) => (i === 0 ? '  ↳ ' : '    ') + l);
}

/** "2 × Lost Cherry      ฿560" padded for a monospace <pre> block. */
export function row(left: string, right: string, width = WIDTH): string[] {
  const room = width - right.length - 1;
  if (left.length <= room) return [left + ' '.repeat(width - left.length - right.length) + right];
  // Wrap long names: amount on the first line.
  const words = left.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const limit = lines.length === 0 ? room : width - 4;
    if ((cur + ' ' + w).trim().length > limit && cur) {
      lines.push(cur);
      cur = '    ' + w;
    } else cur = (cur ? cur + ' ' : '') + w;
  }
  lines.push(cur);
  lines[0] = lines[0] + ' '.repeat(Math.max(1, width - lines[0].length - right.length)) + right;
  return lines;
}

const staffName = (db: Database, id: number | null) =>
  id ? escapeHtml(db.get<{ display_name: string }>('SELECT display_name FROM staff WHERE id = ?', [id])?.display_name ?? 'Staff') : 'Staff';

export function renderOrderCard(db: Database, config: Config, orderId: number): Card {
  const order = db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId])!;
  const session = getSession(db, order.session_id)!;
  const table = getTableById(db, session.table_id);
  const items = orderItems(db, order.id);
  const tz = config.displayTimeZone;
  const body = [
    ...items.flatMap((i) => [...row(`${i.quantity} × ${i.item_name_snapshot}`, formatBaht(i.line_total_satang)), ...noteLines(i.note)]),
    '-'.repeat(WIDTH),
    ...row('ORDER TOTAL', formatBaht(order.total_satang)),
  ];
  const pre = `<pre>${escapeHtml(body.join('\n'))}</pre>`;
  const note = order.notes ? `\nNote: <b>${escapeHtml(order.notes)}</b>\n` : '';

  if (order.status === 'SERVED') {
    return {
      text:
        `✅ <b>ORDER SERVED</b>\nTable: ${table.display_number} | ${session.session_code}\nOrder: ${order.order_number}\n` +
        `Served by: ${staffName(db, order.served_by)}\nServed at: ${formatTime(order.served_at!, tz)}\n${pre}${note}`,
      buttons: [],
    };
  }
  return {
    text:
      `🍸 <b>NEW COCKTAIL ORDER</b>\nTable: ${table.display_number}\nSession: ${session.session_code}\nOrder: ${order.order_number}\n` +
      `Time: ${formatTime(order.created_at, tz)}\n${pre}${note}\nStatus: <b>NEW</b>`,
    buttons: order.serve_action_id ? [[{ text: '✅ Mark as Served', actionId: order.serve_action_id }]] : [],
  };
}

export function renderPaymentCard(db: Database, config: Config, billId: number): Card {
  const bill = getBill(db, billId)!;
  const view = frozenBillView(db, bill);
  const session = getSession(db, bill.session_id)!;
  const table = getTableById(db, session.table_id);
  const head = `Table: ${table.display_number} | ${session.session_code}\nBill: ${bill.bill_number}\nOrders: ${view.orderNumbers.join(', ')}\n`;
  const body = [
    ...view.lines.flatMap((l) => row(`${l.quantity} × ${l.itemName}`, formatBaht(l.lineTotalSatang))),
    '-'.repeat(WIDTH),
    ...row('SUBTOTAL', formatBaht(view.subtotalSatang)),
    ...view.adjustments.flatMap((a) => row(a.label, formatBaht(a.amountSatang))),
  ];
  const pre = `<pre>${escapeHtml(body.join('\n'))}</pre>`;

  if (bill.status === 'PAID') {
    const p = db.get<{ amount_satang: number; method: string; confirmed_by: number; confirmed_at: string }>(
      "SELECT * FROM payments WHERE bill_id = ? AND status = 'CONFIRMED'", [bill.id],
    )!;
    const current = table.current_session_id ? getSession(db, table.current_session_id) : undefined;
    const opened = current && current.id !== session.id;
    const next = opened ? `${current.session_code} (opened)` : `${nextSessionCode(db, table)} (awaiting activation)`;
    const openAction = opened ? undefined : findActionsFor(db, 'bill', bill.id).find((a) => a.action === 'table.open');
    return {
      text:
        `✅ <b>PAYMENT CONFIRMED</b>\n${head}${pre}\nTotal received: <b>${formatBaht(p.amount_satang)}</b>\nMethod: ${escapeHtml(p.method)}\n` +
        `Confirmed by: ${staffName(db, p.confirmed_by)} at ${formatTime(p.confirmed_at, config.displayTimeZone)}\nStatus: <b>CLOSED</b>\n` +
        `Receipt: PDF follows\nNext session: ${next}`,
      buttons: openAction ? [[{ text: `▶️ Open ${nextSessionCode(db, table)}`, actionId: openAction.id }]] : [],
    };
  }
  if (bill.status === 'CANCELLED') {
    return {
      text:
        `↩️ <b>BILL REOPENED / CANCELLED</b>\n${head}${pre}\nWas: <s>${formatBaht(bill.total_satang)}</s>\n` +
        `By: ${staffName(db, bill.cancelled_by)} at ${formatTime(bill.cancelled_at ?? bill.requested_at, config.displayTimeZone)}\n` +
        `A new bill will be issued when the guests request payment again.`,
      buttons: [],
    };
  }
  const actions = findActionsFor(db, 'bill', bill.id);
  const pay = actions.filter((a) => a.action === 'payment.confirm').map((a) => ({ text: `✅ Confirm Paid · ${JSON.parse(a.payload).method}`, actionId: a.id }));
  const reopen = actions.filter((a) => a.action === 'bill.reopen').map((a) => ({ text: '↩️ Reopen bill (add drinks)', actionId: a.id }));
  return {
    text:
      `🧾 <b>PAYMENT REQUESTED</b>\n${head}${pre}\nTOTAL TO COLLECT: <b>${formatBaht(bill.total_satang)}</b>\n` +
      `Requested: ${formatTime(bill.requested_at, config.displayTimeZone)}\nStatus: <b>AWAITING PAYMENT</b>\n` +
      `<i>Only confirm after the money has actually been received.</i>`,
    buttons: [...pay.map((b) => [b]), ...reopen.map((b) => [b])],
  };
}
