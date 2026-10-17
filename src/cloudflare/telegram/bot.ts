import { findActiveStaff, enqueue } from "../domain.ts";
import type { Ctx } from "../domain.ts";
import { findAction } from "../domain.ts";
import type { ActionKind } from "../../domain/actions.ts";
import { audit } from "../domain.ts";
import { currentBillView, reopenBill } from "../domain.ts";
import { getMenu, menuReadiness, setAvailability } from "../domain.ts";
import { markServed } from "../domain.ts";
import { confirmPayment } from "../domain.ts";
import { can, type Permission, type StaffRow } from "../../domain/staff.ts";
import {
  getActiveSession,
  getTableByNumber,
  listTables,
  openSession,
  rotatePin,
  voidSession,
} from "../domain.ts";
import { AppError } from "../../lib/errors.ts";
import { escapeHtml } from "../../lib/html.ts";
import { formatBaht } from "../../lib/money.ts";
import type { TelegramClient } from "../../telegram/api.ts";

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

const actionPermission: Record<ActionKind, Permission> = {
  "order.serve": "order.serve",
  "payment.confirm": "payment.confirm",
  "bill.reopen": "bill.reopen",
  "table.open": "table.open",
  "table.pin": "table.pin",
};

const roleHint: Record<Permission, string> = {
  "order.serve": "staff",
  "table.view": "staff",
  "table.open": "a cashier or lead",
  "table.pin": "a cashier or lead",
  "table.close_empty": "a cashier or lead",
  "bill.reopen": "a cashier or lead",
  "payment.confirm": "a cashier or lead",
  "menu.availability": "a cashier or lead",
  "session.void": "a lead",
};

const isStaffChat = (ctx: Ctx, chatId: number | undefined) =>
  chatId !== undefined && String(chatId) === ctx.config.telegram.staffChatId;

/** Verify membership on every action, including previously enrolled staff. */
async function resolveStaff(ctx: Ctx, tg: TelegramClient, user: TgUser, chatId: number) {
  if (!ctx.config.telegram.groupFullAccess)
    return findActiveStaff(ctx.db, user.id);
  if (!isStaffChat(ctx, chatId) || user.is_bot || !Number.isSafeInteger(user.id) || user.id <= 0)
    return undefined;
  let member: { status: string; is_member?: boolean; user: TgUser };
  try {
    member = await tg.call("getChatMember", {
      chat_id: ctx.config.telegram.staffChatId,
      user_id: user.id,
    });
  } catch {
    console.warn("Telegram group membership could not be verified; access denied");
    return undefined;
  }
  if (member?.user?.id !== user.id || member.user.is_bot ||
      !(["creator", "administrator", "member"].includes(member.status) ||
        (member.status === "restricted" && member.is_member === true)))
    return undefined;
  const name = (user.first_name || user.username || member.user.first_name || String(user.id))
    .replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100);
  return ctx.db.transaction(async (tx) => {
    const existing = await tx.get<StaffRow>("SELECT * FROM staff WHERE telegram_user_id=?", [String(user.id)]);
    if (existing?.active === 1 && existing.role === "lead" && existing.display_name === name)
      return existing;
    const staff: StaffRow = {
      id: existing?.id ?? await tx.id("staff"),
      telegram_user_id: String(user.id), display_name: name, role: "lead", active: 1,
    };
    tx.run(`INSERT INTO staff(id,telegram_user_id,display_name,role,active,created_at)
      VALUES (?,?,?,'lead',1,?) ON CONFLICT(telegram_user_id) DO UPDATE SET
      display_name=excluded.display_name,role='lead',active=1`,
      [staff.id, staff.telegram_user_id, name, ctx.now().toISOString()]);
    audit(tx, ctx, { type: "staff", staff }, "staff.group_access", "staff", staff.id,
      { chatId: ctx.config.telegram.staffChatId, role: "lead" });
    return staff;
  });
}

async function reply(ctx: Ctx, chatId: number, text: string, replyTo?: number) {
  await ctx.db.transaction(async (tx) =>
    enqueue(tx, ctx, "telegram.text", {
      chatId: String(chatId),
      text,
      replyTo,
    }),
  );
}

/** Webhook entry point. Must only be called after the secret-token header was verified. */
export async function handleUpdate(
  ctx: Ctx,
  tg: TelegramClient,
  update: TgUpdate,
) {
  if (!Number.isSafeInteger(update?.update_id)) return;
  if (update.callback_query)
    return handleCallback(ctx, tg, update.callback_query);
  if (update.message?.text?.startsWith("/"))
    return handleCommand(ctx, tg, update.message);
}

async function handleCallback(
  ctx: Ctx,
  tg: TelegramClient,
  cq: TgCallbackQuery,
) {
  const answer = (text: string, alert = false) =>
    tg
      .call("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: text.slice(0, 190),
        show_alert: alert,
      })
      .catch((err) =>
        console.warn("answerCallbackQuery failed", {
          error: (err as Error).message,
        }),
      );

  const m = /^a:([A-Za-z0-9_-]{10,40})$/.exec(cq.data ?? "");
  if (!m) return answer("Unknown action", true);
  if (!isStaffChat(ctx, cq.message?.chat.id))
    return answer("This action is only available in the staff group.", true);

  const action = await findAction(ctx.db, m[1]);
  if (!action) return answer("This button is no longer valid.", true);
  const staff = await resolveStaff(ctx, tg, cq.from, cq.message!.chat.id);
  const permission = actionPermission[action.action as ActionKind];
  if (!can(staff, permission)) {
    await ctx.db.transaction(async (tx) =>
      audit(
        tx,
        ctx,
        staff
          ? { type: "staff", staff }
          : { type: "unknown", telegramUserId: String(cq.from.id) },
        "telegram.unauthorized",
        action.entity_type,
        action.entity_id,
        {
          action: action.action,
        },
      ),
    );
    return answer(ctx.config.telegram.groupFullAccess
      ? "Access denied: current staff group membership could not be verified. Ask an admin to make the bot a group administrator."
      : `Not authorized. This needs ${roleHint[permission]}.`, true);
  }
  const actor = { type: "staff" as const, staff };
  try {
    switch (action.action) {
      case "order.serve": {
        const r = await markServed(ctx, action.entity_id, actor);
        return answer(
          r.changed
            ? `${r.order.order_number} marked as served`
            : `${r.order.order_number} was already served`,
        );
      }
      case "payment.confirm": {
        const method = String(JSON.parse(action.payload).method);
        const r = await confirmPayment(ctx, action.entity_id, method, actor);
        return answer(
          r.changed
            ? `Payment of ${formatBaht(r.payment.amount_satang)} recorded. Table closed.`
            : `${r.bill.bill_number} was already paid`,
        );
      }
      case "bill.reopen": {
        const r = await reopenBill(ctx, { billId: action.entity_id }, actor);
        return answer(
          r.changed
            ? `${r.bill.bill_number} cancelled; table can order again`
            : "Bill was already reopened",
        );
      }
      case "table.open": {
        const s = await openSession(
          ctx,
          Number(JSON.parse(action.payload).tableNumber),
          actor,
        );
        return answer(`${s.session_code} opened`);
      }
      case "table.pin": {
        const s = await rotatePin(ctx, action.entity_id, actor);
        return answer(`New PIN issued for ${s.session_code}`);
      }
    }
  } catch (err) {
    if (err instanceof AppError && err.code !== "BUSY")
      return answer(err.message, true);
    console.error("callback failed", {
      error: (err as Error).message,
      action: action.action,
    });
    await answer("Something went wrong. Please try again.", true);
    throw err;
  }
}

const HELP = [
  "<b>224 Live House bot</b>",
  "/tables – table & session overview",
  "/open_table N – open the next session (cashier/lead)",
  "/pin N – issue a new join PIN (cashier/lead)",
  "/bill N – current bill for a table",
  "/reopen_bill N – cancel a pending bill so guests can add drinks (cashier/lead)",
  "/close_table N – close a session that has no orders (cashier/lead)",
  "/void_table N CONFIRM – void an unpaid session (lead)",
  "/menu – menu, prices and availability",
  "/soldout ITEM · /restock ITEM – availability (cashier/lead)",
  "/whoami – show your Telegram user ID",
].join("\n");

function parseTable(arg: string | undefined) {
  const n = Number(arg);
  if (!arg || !Number.isSafeInteger(n) || n <= 0)
    throw new AppError(
      400,
      "USAGE",
      "Please give a table number, e.g. /open_table 1",
    );
  return n;
}

async function handleCommand(ctx: Ctx, tg: TelegramClient, msg: TgMessage) {
  const [rawCmd, ...args] = msg.text!.trim().split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const from = msg.from;
  if (!from) return;

  if (cmd === "/whoami") {
    const s = ctx.config.telegram.groupFullAccess
      ? await resolveStaff(ctx, tg, from, msg.chat.id)
      : await findActiveStaff(ctx.db, from.id);
    return reply(
      ctx,
      msg.chat.id,
      `Your Telegram user ID: <code>${from.id}</code>${s ? (ctx.config.telegram.groupFullAccess ? "\nFull staff access through this group." : `\nRole: ${s.role}`) : (ctx.config.telegram.groupFullAccess ? "\nStaff group membership has not been verified." : "\nNot registered as staff.")}`,
      msg.message_id,
    );
  }
  if (!isStaffChat(ctx, msg.chat.id)) {
    if (cmd === "/start" || cmd === "/help")
      await reply(
        ctx,
        msg.chat.id,
        ctx.config.telegram.groupFullAccess
          ? "Use this bot in the 224 Event staff group. Every current group member has full staff access."
          : "This bot is for 224 Live House staff. Use /whoami to get your user ID for registration.",
      );
    return;
  }
  const staff = await resolveStaff(ctx, tg, from, msg.chat.id);
  const need = async (p: Permission): Promise<StaffRow> => {
    if (!can(staff, p)) {
      await ctx.db.transaction(async (tx) =>
        audit(
          tx,
          ctx,
          staff
            ? { type: "staff", staff }
            : { type: "unknown", telegramUserId: String(from.id) },
          "telegram.unauthorized",
          "command",
          null,
          { cmd },
        ),
      );
      throw new AppError(
        403,
        "FORBIDDEN",
        ctx.config.telegram.groupFullAccess
          ? "Access denied: current staff group membership could not be verified. Ask an admin to make the bot a group administrator."
          : `Not authorized. ${cmd} needs ${roleHint[p]}.`,
      );
    }
    return staff;
  };

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        return reply(ctx, msg.chat.id, ctx.config.telegram.groupFullAccess
          ? HELP.replace(/ \((?:cashier\/lead|lead)\)/g, "") + "\n\nEvery current member of this group has full staff access."
          : HELP);
      case "/tables": {
        await need("table.view");
        const rows = (await listTables(ctx.db)).map((t) => {
          const active =
            t.session_status === "OPEN" ||
            t.session_status === "PAYMENT_REQUESTED";
          return active
            ? `• Table ${t.display_number}: <b>${t.session_code}</b> ${t.session_status === "OPEN" ? "🟢 open" : "🧾 payment requested"} · PIN <code>${t.join_pin}</code>`
            : `• Table ${t.display_number}: ⚪ available (next TABLE${t.display_number}-${(t.last_round ?? 0) + 1})`;
        });
        return reply(
          ctx,
          msg.chat.id,
          rows.length
            ? `<b>Tables</b>\n${rows.join("\n")}`
            : "No tables configured.",
        );
      }
      case "/open_table": {
        const s = await need("table.open");
        await openSession(ctx, parseTable(args[0]), {
          type: "staff",
          staff: s,
        });
        return; // the session announcement (with PIN) is sent via the outbox
      }
      case "/pin": {
        const s = await need("table.pin");
        await rotatePin(ctx, parseTable(args[0]), { type: "staff", staff: s });
        return;
      }
      case "/bill": {
        await need("table.view");
        const n = parseTable(args[0]);
        const table = await getTableByNumber(ctx.db, n);
        const session = table && (await getActiveSession(ctx.db, table));
        if (!session)
          return reply(ctx, msg.chat.id, `Table ${n} has no active session.`);
        const bill = await currentBillView(ctx.db, ctx.config, session);
        const lines = bill.lines.map(
          (l) =>
            `${l.quantity} × ${escapeHtml(l.itemName)} — ${formatBaht(l.lineTotalSatang)} (${l.orderNumber})`,
        );
        return reply(
          ctx,
          msg.chat.id,
          `<b>${session.session_code}</b> · ${bill.status}\n${lines.join("\n") || "No orders yet."}\nTotal: <b>${formatBaht(bill.totalSatang)}</b>`,
        );
      }
      case "/reopen_bill": {
        const s = await need("bill.reopen");
        await reopenBill(
          ctx,
          { tableNumber: parseTable(args[0]) },
          { type: "staff", staff: s },
        );
        return reply(
          ctx,
          msg.chat.id,
          `Bill for table ${args[0]} reopened. Guests can order again.`,
        );
      }
      case "/close_table": {
        const s = await need("table.close_empty");
        const r = await voidSession(
          ctx,
          parseTable(args[0]),
          { type: "staff", staff: s },
          { onlyIfEmpty: true, reason: "closed without orders" },
        );
        return reply(
          ctx,
          msg.chat.id,
          `${r.session.session_code} closed (no orders). Next session: ${r.next} (awaiting activation).`,
        );
      }
      case "/void_table": {
        const s = await need("session.void");
        const n = parseTable(args[0]);
        if (args[1] !== "CONFIRM")
          return reply(
            ctx,
            msg.chat.id,
            `This voids the unpaid session on table ${n} (orders are kept for audit). Send <code>/void_table ${n} CONFIRM</code> to proceed.`,
          );
        const r = await voidSession(
          ctx,
          n,
          { type: "staff", staff: s },
          {
            onlyIfEmpty: false,
            reason: args.slice(2).join(" ") || "voided by lead",
          },
        );
        return reply(
          ctx,
          msg.chat.id,
          `⚠️ ${r.session.session_code} VOIDED by ${escapeHtml(s.display_name)} (${r.orderCount} order(s) kept, unpaid). Next session: ${r.next}.`,
        );
      }
      case "/menu": {
        await need("table.view");
        const readiness = await menuReadiness(ctx.db);
        const text = (await getMenu(ctx.db))
          .map(
            (c) =>
              `<b>${escapeHtml(c.name)}</b>\n` +
              c.items
                .map(
                  (i) =>
                    `${i.available ? "•" : "✖"} ${escapeHtml(i.name)} — ${i.price_satang ? formatBaht(i.price_satang) : "<i>no price</i>"}${i.available ? "" : " (sold out)"}`,
                )
                .join("\n"),
          )
          .join("\n\n");
        return reply(
          ctx,
          msg.chat.id,
          `${text}\n\n${readiness.ready ? "✅ Ordering enabled" : `⛔ Ordering disabled: ${readiness.missing.length} item(s) without a price`}`,
        );
      }
      case "/soldout":
      case "/restock": {
        const s = await need("menu.availability");
        if (!args.length)
          throw new AppError(400, "USAGE", `Usage: ${cmd} Negroni`);
        const item = await setAvailability(
          ctx,
          args.join(" "),
          cmd === "/restock",
          { type: "staff", staff: s },
        );
        return reply(
          ctx,
          msg.chat.id,
          `${escapeHtml(item.name)} is now ${item.available ? "available" : "sold out"}.`,
        );
      }
      default:
        return;
    }
  } catch (err) {
    if (err instanceof AppError && err.code !== "BUSY")
      return reply(
        ctx,
        msg.chat.id,
        `⚠️ ${escapeHtml(err.message)}`,
        msg.message_id,
      );
    console.error("command failed", { cmd, error: (err as Error).message });
    throw err;
  }
}
