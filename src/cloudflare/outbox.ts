import {
  HttpTelegramClient,
  keyboard,
  TelegramError,
  type TelegramClient,
} from "../telegram/api.ts";
import { redact } from "../lib/log.ts";
import { randomToken } from "../lib/ids.ts";
import { stamp, type Ctx } from "./domain.ts";
import { generateReceipt, readPdf } from "./receipt.ts";
import {
  renderOrderCard,
  renderPaymentCard,
  type Card,
} from "./telegram/render.ts";
import { handleUpdate } from "./telegram/bot.ts";

export function telegram(c: Ctx) {
  return new HttpTelegramClient(
    c.config.telegram.apiBase,
    c.config.telegram.botToken,
  );
}
/** A renewable global delivery lease serializes card edits and receipt sends.
 * No money/session mutation waits for Telegram. Delivery is at-least-once;
 * Telegram has no idempotency key for sendMessage/sendDocument after a timeout.
 */
export async function drain(c: Ctx, tg: TelegramClient = telegram(c)) {
  const token = randomToken(),
    start = Date.now();
  const locked = await c.db.transaction(async (tx) => {
    const lease = await tx.get<{ expires_at: string }>(
      "SELECT expires_at FROM worker_leases WHERE name='delivery'",
    );
    if (lease && lease.expires_at > stamp(c)) return false;
    tx.run(
      "INSERT INTO worker_leases(name,token,expires_at) VALUES ('delivery',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at",
      [token, new Date(c.now().getTime() + 120000).toISOString()],
    );
    return true;
  });
  if (!locked) return;
  try {
    // Inbox is persisted before acknowledging the webhook. Transient errors retry.
    const inbox = await c.db.all<any>(
      "SELECT * FROM telegram_inbox WHERE processed_at IS NULL AND next_retry_at<=? ORDER BY update_id LIMIT 5",
      [stamp(c)],
    );
    for (const job of inbox) {
      if (Date.now() - start > 18000 || !(await renew(c, token))) break;
      try {
        await handleUpdate(c, tg, JSON.parse(job.payload));
        await c.db.transaction(async (tx) => {
          tx.run("UPDATE telegram_inbox SET processed_at=? WHERE update_id=?", [
            stamp(c),
            job.update_id,
          ]);
          tx.run(
            "INSERT INTO telegram_updates(update_id,received_at) VALUES (?,?) ON CONFLICT(update_id) DO NOTHING",
            [job.update_id, stamp(c)],
          );
        });
      } catch (error) {
        await c.db.transaction(async (tx) =>
          tx.run(
            "UPDATE telegram_inbox SET attempts=attempts+1,next_retry_at=? WHERE update_id=?",
            [
              new Date(
                c.now().getTime() +
                  Math.min(300000, 2000 * 2 ** Math.min(job.attempts, 7)),
              ).toISOString(),
              job.update_id,
            ],
          ),
        );
        console.warn(
          "Telegram inbox retry",
          job.update_id,
          redact(String(error)),
        );
      }
    }
    for (let count = 0; count < 8 && Date.now() - start < 18000; count++) {
      if (!(await renew(c, token))) break;
      const ev = await c.db.get<any>(
        "SELECT * FROM outbox_events WHERE delivered_at IS NULL AND next_retry_at<=? ORDER BY id LIMIT 1",
        [stamp(c)],
      );
      if (!ev) break;
      try {
        await deliver(c, tg, ev.event_type, JSON.parse(ev.payload));
        await c.db.transaction(async (tx) =>
          tx.run(
            "UPDATE outbox_events SET delivered_at=?,attempts=attempts+1,last_error=NULL WHERE id=?",
            [stamp(c), ev.id],
          ),
        );
      } catch (error) {
        let delay = Math.min(
          c.config.outbox.maxBackoffMs,
          2000 * 2 ** Math.min(ev.attempts, 16),
        );
        if (error instanceof TelegramError && error.retryAfterSec)
          delay = Math.max(delay, error.retryAfterSec * 1000);
        const text = redact(String(error)).slice(0, 500);
        await c.db.transaction(async (tx) =>
          tx.run(
            "UPDATE outbox_events SET attempts=attempts+1,next_retry_at=?,last_error=? WHERE id=?",
            [new Date(c.now().getTime() + delay).toISOString(), text, ev.id],
          ),
        );
        console.warn("Outbox retry", ev.id, text);
      }
    }
  } finally {
    await c.db.transaction(async (tx) =>
      tx.run("DELETE FROM worker_leases WHERE name='delivery' AND token=?", [
        token,
      ]),
    );
  }
}
async function renew(c: Ctx, token: string) {
  return c.db.transaction(async (tx) => {
    const lease = await tx.get<{ token: string; expires_at: string }>(
      "SELECT * FROM worker_leases WHERE name='delivery'",
    );
    if (!lease || lease.token !== token || lease.expires_at <= stamp(c))
      return false;
    tx.run(
      "UPDATE worker_leases SET expires_at=? WHERE name='delivery' AND token=?",
      [new Date(c.now().getTime() + 120000).toISOString(), token],
    );
    return true;
  });
}
async function record(c: Ctx, type: string, id: number, messageId: number) {
  await c.db.transaction(async (tx) =>
    tx.run(
      `INSERT INTO telegram_messages(event_type,entity_id,chat_id,message_id,delivery_status,created_at,updated_at) VALUES (?,?,?,?,'SENT',?,?) ON CONFLICT(event_type,entity_id) DO UPDATE SET message_id=excluded.message_id,delivery_status='SENT',last_error=NULL,updated_at=excluded.updated_at`,
      [type, id, c.config.telegram.staffChatId, messageId, stamp(c), stamp(c)],
    ),
  );
}
async function syncCard(
  c: Ctx,
  tg: TelegramClient,
  type: string,
  id: number,
  card: Card,
) {
  const existing = await c.db.get<{ message_id: number }>(
    "SELECT * FROM telegram_messages WHERE event_type=? AND entity_id=?",
    [type, id],
  );
  const params = {
    chat_id: c.config.telegram.staffChatId,
    text: card.text,
    parse_mode: "HTML",
    reply_markup: keyboard(card.buttons),
  };
  if (existing?.message_id) {
    try {
      await tg.call("editMessageText", {
        ...params,
        message_id: existing.message_id,
      });
      return;
    } catch (e) {
      if (
        e instanceof TelegramError &&
        /message is not modified/i.test(e.description)
      )
        return;
      if (
        !(
          e instanceof TelegramError &&
          /message to edit not found|message can't be edited/i.test(
            e.description,
          )
        )
      )
        throw e;
    }
  }
  const sent = await tg.call<{ message_id: number }>("sendMessage", params);
  await record(c, type, id, sent.message_id);
}
async function deliver(c: Ctx, tg: TelegramClient, type: string, p: any) {
  if (type === "receipt.generate")
    return generateReceipt(c, p.receiptId, !!p.send);
  if (!c.config.telegram.staffChatId)
    throw new Error("TELEGRAM_STAFF_CHAT_ID not configured");
  switch (type) {
    case "telegram.text":
      return tg.call("sendMessage", {
        chat_id: p.chatId ?? c.config.telegram.staffChatId,
        text: p.text,
        parse_mode: "HTML",
        ...(p.buttons ? { reply_markup: keyboard(p.buttons) } : {}),
        ...(p.replyTo
          ? {
              reply_parameters: {
                message_id: p.replyTo,
                allow_sending_without_reply: true,
              },
            }
          : {}),
      });
    case "telegram.order_card":
      return syncCard(
        c,
        tg,
        "order_card",
        p.orderId,
        await renderOrderCard(c.db, c.config, p.orderId),
      );
    case "telegram.payment_card":
      return syncCard(
        c,
        tg,
        "payment_card",
        p.billId,
        await renderPaymentCard(c.db, c.config, p.billId),
      );
    case "telegram.receipt_document": {
      const sent = await c.db.get<{ delivery_status: string }>(
        "SELECT * FROM telegram_messages WHERE event_type='receipt_document' AND entity_id=?",
        [p.receiptId],
      );
      if (sent?.delivery_status === "SENT") return;
      const r = await c.db.get<any>("SELECT * FROM receipts WHERE id=?", [
        p.receiptId,
      ]);
      let pdf = await readPdf(c, r.id);
      if (!pdf) {
        await generateReceipt(c, r.id, false);
        pdf = await readPdf(c, r.id);
      }
      const msg = await tg.sendDocument(
        c.config.telegram.staffChatId,
        `${r.receipt_number}.pdf`,
        Buffer.from(pdf!),
        `🧾 Receipt <b>${r.receipt_number}</b>`,
      );
      return record(c, "receipt_document", r.id, msg.message_id);
    }
    default:
      throw new Error(`Unknown outbox event ${type}`);
  }
}
