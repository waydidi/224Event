import type { Ctx } from '../context.ts';
import { findAction, type ActionKind } from '../domain/actions.ts';
import { audit } from '../domain/audit.ts';
import { currentBillView, reopenBill } from '../domain/billing.ts';
import { getMenu, menuReadiness, setAvailability } from '../domain/menu.ts';
import { markServed } from '../domain/orders.ts';
import { confirmPayment } from '../domain/payments.ts';
import { can, findActiveStaff, upsertStaff, type Permission, type StaffRow } from '../domain/staff.ts';
import { getActiveSession, getTableByNumber, listTables, openSession, rotatePin, voidSession } from '../domain/tables.ts';
import { AppError } from '../lib/errors.ts';
import { escapeHtml } from '../lib/html.ts';
import { formatBaht } from '../lib/money.ts';
import { enqueue } from '../outbox/outbox.ts';
import type { TelegramClient } from './api.ts';

interface TgUser { id: number; first_name?: string; username?: string }
interface TgMessage { message_id: number; chat: { id: number; type: string }; from?: TgUser; text?: string }
interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }

const actionPermission: Record<ActionKind, Permission> = {
  'order.serve': 'order.serve',
  'payment.confirm': 'payment.confirm',
  'bill.reopen': 'bill.reopen',
  'table.open': 'table.open',
  'table.pin': 'table.pin',
};

const roleHint: Record<Permission, string> = {
  'order.serve': 'staff',
  'table.view': 'staff',
  'table.open': 'a cashier or lead',
  'table.pin': 'a cashier or lead',
  'table.close_empty': 'a cashier or lead',
  'bill.reopen': 'a cashier or lead',
  'payment.confirm': 'a cashier or lead',
  'menu.availability': 'a cashier or lead',
  'session.void': 'a lead',
};

const isStaffChat = (ctx: Ctx, chatId: number | undefined) => chatId !== undefined && String(chatId) === ctx.config.telegram.staffChatId;

/**
 * The staff member behind a message in the staff group. When the venue lets every group member act as a
 * cashier, unknown members are registered on first use (so audit entries still carry their name);
 * anyone staff explicitly deactivated stays blocked.
 */
function staffFor(ctx: Ctx, from: TgUser): StaffRow | undefined {
  const known = findActiveStaff(ctx.db, from.id);
  if (known || !ctx.config.telegram.groupMembersAreCashiers) return known;
  if (ctx.db.get('SELECT 1 AS x FROM staff WHERE telegram_user_id = ?', [String(from.id)])) return undefined;
  upsertStaff(ctx, String(from.id), from.first_name || from.username || `Staff ${from.id}`, 'cashier', true);
  return findActiveStaff(ctx.db, from.id);
}

function reply(ctx: Ctx, chatId: number, text: string, replyTo?: number) {
  ctx.db.tx(() => enqueue(ctx, 'telegram.text', { chatId: String(chatId), text, replyTo }));
  ctx.kick();
}

/** Webhook entry point. Must only be called after the secret-token header was verified. */
export async function handleUpdate(ctx: Ctx, tg: TelegramClient, update: TgUpdate) {
  if (!Number.isSafeInteger(update?.update_id)) return;
  // Telegram retries deliveries it thinks failed; process each update once.
  const fresh = ctx.db.run('INSERT INTO telegram_updates(update_id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [update.update_id, ctx.now().toISOString()]);
  if (Number(fresh.changes) === 0) return;
  if (update.callback_query) return handleCallback(ctx, tg, update.callback_query);
  if (update.message?.text?.startsWith('/')) return handleCommand(ctx, update.message);
}

async function handleCallback(ctx: Ctx, tg: TelegramClient, cq: TgCallbackQuery) {
  const answer = (text: string, alert = false) =>
    tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: text.slice(0, 190), show_alert: alert }).catch((err) =>
      ctx.log.warn('answerCallbackQuery failed', { error: (err as Error).message }),
    );

  const m = /^a:([A-Za-z0-9_-]{10,40})$/.exec(cq.data ?? '');
  if (!m) return answer('Unknown action', true);
  if (!isStaffChat(ctx, cq.message?.chat.id)) return answer('This action is only available in the staff group.', true);

  const action = findAction(ctx.db, m[1]);
  if (!action) return answer('This button is no longer valid.', true);
  const staff = staffFor(ctx, cq.from);
  const permission = actionPermission[action.action];
  if (!can(staff, permission)) {
    ctx.db.tx(() =>
      audit(ctx, staff ? { type: 'staff', staff } : { type: 'unknown', telegramUserId: String(cq.from.id) }, 'telegram.unauthorized', action.entity_type, action.entity_id, {
        action: action.action,
      }),
    );
    return answer(`Not authorized. This needs ${roleHint[permission]}.`, true);
  }
  const actor = { type: 'staff' as const, staff };
  try {
    switch (action.action) {
      case 'order.serve': {
        const r = markServed(ctx, action.entity_id, actor);
        return answer(r.changed ? `${r.order.order_number} marked as served` : `${r.order.order_number} was already served`);
      }
      case 'payment.confirm': {
        const method = String(JSON.parse(action.payload).method);
        const r = confirmPayment(ctx, action.entity_id, method, actor);
        return answer(r.changed ? `Payment of ${formatBaht(r.payment.amount_satang)} recorded. Table closed.` : `${r.bill.bill_number} was already paid`);
      }
      case 'bill.reopen': {
        const r = reopenBill(ctx, { billId: action.entity_id }, actor);
        return answer(r.changed ? `${r.bill.bill_number} cancelled; table can order again` : 'Bill was already reopened');
      }
      case 'table.open': {
        const s = openSession(ctx, Number(JSON.parse(action.payload).tableNumber), actor);
        return answer(`${s.session_code} opened`);
      }
      case 'table.pin': {
        const s = rotatePin(ctx, action.entity_id, actor);
        return answer(`New PIN issued for ${s.session_code}`);
      }
    }
  } catch (err) {
    if (err instanceof AppError) return answer(err.message, true);
    ctx.log.error('callback failed', { error: (err as Error).message, action: action.action });
    return answer('Something went wrong. Please try again.', true);
  }
}

const HELP = [
  '<b>224 Live House bot</b>',
  '/tables – table & session overview',
  '/open_table N – open the next session (cashier/lead)',
  '/pin N – issue a new join PIN (cashier/lead)',
  '/bill N – current bill for a table',
  '/reopen_bill N – cancel a pending bill so guests can add drinks (cashier/lead)',
  '/close_table N – close a session that has no orders (cashier/lead)',
  '/void_table N CONFIRM – void an unpaid session (lead)',
  '/menu – menu, prices and availability',
  '/soldout ITEM · /restock ITEM – availability (cashier/lead)',
  '/whoami – show your Telegram user ID',
].join('\n');

function parseTable(arg: string | undefined) {
  const n = Number(arg);
  if (!arg || !Number.isSafeInteger(n) || n <= 0) throw new AppError(400, 'USAGE', 'Please give a table number, e.g. /open_table 1');
  return n;
}

function handleCommand(ctx: Ctx, msg: TgMessage) {
  const [rawCmd, ...args] = msg.text!.trim().split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase();
  const from = msg.from;
  if (!from) return;

  if (cmd === '/whoami') {
    const s = findActiveStaff(ctx.db, from.id);
    return reply(ctx, msg.chat.id, `Your Telegram user ID: <code>${from.id}</code>${s ? `\nRole: ${s.role}` : '\nNot registered as staff.'}`, msg.message_id);
  }
  if (!isStaffChat(ctx, msg.chat.id)) {
    if (cmd === '/start' || cmd === '/help') reply(ctx, msg.chat.id, 'This bot is for 224 Live House staff. Use /whoami to get your user ID for registration.');
    return;
  }
  const staff = staffFor(ctx, from);
  const need = (p: Permission): StaffRow => {
    if (!can(staff, p)) {
      ctx.db.tx(() => audit(ctx, staff ? { type: 'staff', staff } : { type: 'unknown', telegramUserId: String(from.id) }, 'telegram.unauthorized', 'command', null, { cmd }));
      throw new AppError(403, 'FORBIDDEN', `Not authorized. ${cmd} needs ${roleHint[p]}.`);
    }
    return staff;
  };

  try {
    switch (cmd) {
      case '/start':
      case '/help':
        return reply(ctx, msg.chat.id, HELP);
      case '/tables': {
        need('table.view');
        const rows = listTables(ctx.db).map((t) => {
          const active = t.session_status === 'OPEN' || t.session_status === 'PAYMENT_REQUESTED';
          return active
            ? `• Table ${t.display_number}: <b>${t.session_code}</b> ${t.session_status === 'OPEN' ? '🟢 open' : '🧾 payment requested'} · PIN <code>${t.join_pin}</code>`
            : `• Table ${t.display_number}: ⚪ available (next TABLE${t.display_number}-${(t.last_round ?? 0) + 1})`;
        });
        return reply(ctx, msg.chat.id, rows.length ? `<b>Tables</b>\n${rows.join('\n')}` : 'No tables configured.');
      }
      case '/open_table': {
        const s = need('table.open');
        openSession(ctx, parseTable(args[0]), { type: 'staff', staff: s });
        return; // the session announcement (with PIN) is sent via the outbox
      }
      case '/pin': {
        const s = need('table.pin');
        rotatePin(ctx, parseTable(args[0]), { type: 'staff', staff: s });
        return;
      }
      case '/bill': {
        need('table.view');
        const n = parseTable(args[0]);
        const table = getTableByNumber(ctx.db, n);
        const session = table && getActiveSession(ctx.db, table);
        if (!session) return reply(ctx, msg.chat.id, `Table ${n} has no active session.`);
        const bill = currentBillView(ctx.db, ctx.config, session);
        const lines = bill.lines.map((l) => `${l.quantity} × ${escapeHtml(l.itemName)} — ${formatBaht(l.lineTotalSatang)} (${l.orderNumber})`);
        return reply(ctx, msg.chat.id, `<b>${session.session_code}</b> · ${bill.status}\n${lines.join('\n') || 'No orders yet.'}\nTotal: <b>${formatBaht(bill.totalSatang)}</b>`);
      }
      case '/reopen_bill': {
        const s = need('bill.reopen');
        reopenBill(ctx, { tableNumber: parseTable(args[0]) }, { type: 'staff', staff: s });
        return reply(ctx, msg.chat.id, `Bill for table ${args[0]} reopened. Guests can order again.`);
      }
      case '/close_table': {
        const s = need('table.close_empty');
        const r = voidSession(ctx, parseTable(args[0]), { type: 'staff', staff: s }, { onlyIfEmpty: true, reason: 'closed without orders' });
        return reply(ctx, msg.chat.id, `${r.session.session_code} closed (no orders). Next session: ${r.next} (awaiting activation).`);
      }
      case '/void_table': {
        const s = need('session.void');
        const n = parseTable(args[0]);
        if (args[1] !== 'CONFIRM') return reply(ctx, msg.chat.id, `This voids the unpaid session on table ${n} (orders are kept for audit). Send <code>/void_table ${n} CONFIRM</code> to proceed.`);
        const r = voidSession(ctx, n, { type: 'staff', staff: s }, { onlyIfEmpty: false, reason: args.slice(2).join(' ') || 'voided by lead' });
        return reply(ctx, msg.chat.id, `⚠️ ${r.session.session_code} VOIDED by ${escapeHtml(s.display_name)} (${r.orderCount} order(s) kept, unpaid). Next session: ${r.next}.`);
      }
      case '/menu': {
        need('table.view');
        const readiness = menuReadiness(ctx.db);
        const text = getMenu(ctx.db)
          .map((c) => `<b>${escapeHtml(c.name)}</b>\n` + c.items.map((i) => `${i.available ? '•' : '✖'} ${escapeHtml(i.name)} — ${i.price_satang ? formatBaht(i.price_satang) : '<i>no price</i>'}${i.available ? '' : ' (sold out)'}`).join('\n'))
          .join('\n\n');
        return reply(ctx, msg.chat.id, `${text}\n\n${readiness.ready ? '✅ Ordering enabled' : `⛔ Ordering disabled: ${readiness.missing.length} item(s) without a price`}`);
      }
      case '/soldout':
      case '/restock': {
        const s = need('menu.availability');
        if (!args.length) throw new AppError(400, 'USAGE', `Usage: ${cmd} Negroni`);
        const item = setAvailability(ctx, args.join(' '), cmd === '/restock', { type: 'staff', staff: s });
        return reply(ctx, msg.chat.id, `${escapeHtml(item.name)} is now ${item.available ? 'available' : 'sold out'}.`);
      }
      default:
        return;
    }
  } catch (err) {
    if (err instanceof AppError) return reply(ctx, msg.chat.id, `⚠️ ${escapeHtml(err.message)}`, msg.message_id);
    ctx.log.error('command failed', { cmd, error: (err as Error).message });
    return reply(ctx, msg.chat.id, '⚠️ Something went wrong.', msg.message_id);
  }
}
