import type { Ctx } from '../context.ts';
import { redact } from '../lib/log.ts';
import { generateReceipt, getReceipt, readReceiptPdf } from '../receipts/service.ts';
import { keyboard, TelegramError, type TelegramClient } from '../telegram/api.ts';
import { renderOrderCard, renderPaymentCard, type Card } from '../telegram/render.ts';

interface OutboxRow {
  id: number;
  event_type: string;
  payload: string;
  attempts: number;
}

interface MessageRow {
  id: number;
  message_id: number | null;
  delivery_status: string;
}

/**
 * Delivers outbox events with retry + exponential backoff. Card handlers are
 * "sync to authoritative state" operations (send if never sent, else edit),
 * so they are order-independent and safe to retry.
 */
export class OutboxWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;

  private readonly ctx: Ctx;
  private readonly tg: TelegramClient;

  constructor(ctx: Ctx, tg: TelegramClient) {
    this.ctx = ctx;
    this.tg = tg;
  }

  start() {
    this.timer = setInterval(() => this.kick(), this.ctx.config.outbox.pollIntervalMs);
    this.timer.unref();
    this.kick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  kick() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
  }

  /** Process until nothing is due (used by tests and on kicks). */
  async drain() {
    while (this.running) await this.running;
    await this.loop();
  }

  private async loop() {
    do {
      this.again = false;
      while (await this.processBatch()) {
        /* keep going while work was done */
      }
    } while (this.again);
  }

  private async processBatch(): Promise<boolean> {
    const now = this.ctx.now().toISOString();
    const due = this.ctx.db.all<OutboxRow>(
      'SELECT id, event_type, payload, attempts FROM outbox_events WHERE delivered_at IS NULL AND next_retry_at <= ? ORDER BY id LIMIT 20',
      [now],
    );
    for (const ev of due) {
      try {
        await this.handle(ev.event_type, JSON.parse(ev.payload));
        this.ctx.db.run('UPDATE outbox_events SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?', [this.ctx.now().toISOString(), ev.id]);
      } catch (err) {
        const attempts = ev.attempts + 1;
        let delay = Math.min(this.ctx.config.outbox.maxBackoffMs, 2000 * 2 ** Math.min(attempts - 1, 16));
        if (err instanceof TelegramError && err.retryAfterSec) delay = Math.max(delay, err.retryAfterSec * 1000);
        const message = redact((err as Error).message ?? String(err)).slice(0, 500);
        this.ctx.db.run('UPDATE outbox_events SET attempts = ?, next_retry_at = ?, last_error = ? WHERE id = ?', [
          attempts, new Date(this.ctx.now().getTime() + delay).toISOString(), message, ev.id,
        ]);
        this.ctx.log.warn('outbox delivery failed', { id: ev.id, type: ev.event_type, attempts, retryInMs: delay, error: message });
      }
    }
    return due.length > 0 && due.length === 20;
  }

  private get chatId() {
    const id = this.ctx.config.telegram.staffChatId;
    if (!id) throw new Error('TELEGRAM_STAFF_CHAT_ID not configured');
    return id;
  }

  private async handle(type: string, payload: any) {
    switch (type) {
      case 'telegram.order_card':
        return this.syncCard('order_card', payload.orderId, renderOrderCard(this.ctx.db, this.ctx.config, payload.orderId));
      case 'telegram.payment_card':
        return this.syncCard('payment_card', payload.billId, renderPaymentCard(this.ctx.db, this.ctx.config, payload.billId));
      case 'telegram.text':
        await this.tg.call('sendMessage', {
          chat_id: payload.chatId ?? this.chatId,
          text: payload.text,
          parse_mode: 'HTML',
          ...(payload.buttons ? { reply_markup: keyboard(payload.buttons) } : {}),
          ...(payload.replyTo ? { reply_parameters: { message_id: payload.replyTo, allow_sending_without_reply: true } } : {}),
        });
        return;
      case 'receipt.generate':
        await generateReceipt(this.ctx, payload.receiptId, { send: !!payload.send });
        return;
      case 'telegram.receipt_document':
        return this.sendReceipt(payload.receiptId);
      default:
        throw new Error(`Unknown outbox event ${type}`);
    }
  }

  private message(eventType: string, entityId: number) {
    return this.ctx.db.get<MessageRow>('SELECT * FROM telegram_messages WHERE event_type = ? AND entity_id = ?', [eventType, entityId]);
  }

  private record(eventType: string, entityId: number, messageId: number | null, status: 'SENT' | 'FAILED', error: string | null) {
    const now = this.ctx.now().toISOString();
    this.ctx.db.run(
      `INSERT INTO telegram_messages(event_type, entity_id, chat_id, message_id, delivery_status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_type, entity_id) DO UPDATE SET
         message_id = COALESCE(excluded.message_id, telegram_messages.message_id),
         delivery_status = CASE WHEN telegram_messages.delivery_status = 'SENT' AND excluded.delivery_status = 'FAILED' THEN 'SENT' ELSE excluded.delivery_status END,
         last_error = excluded.last_error, updated_at = excluded.updated_at`,
      [eventType, entityId, this.chatId, messageId, status, error, now, now],
    );
  }

  private async syncCard(eventType: string, entityId: number, card: Card) {
    const existing = this.message(eventType, entityId);
    const params = { chat_id: this.chatId, text: card.text, parse_mode: 'HTML', reply_markup: keyboard(card.buttons) };
    try {
      if (existing?.message_id) {
        try {
          await this.tg.call('editMessageText', { ...params, message_id: existing.message_id });
        } catch (err) {
          if (err instanceof TelegramError && /message is not modified/i.test(err.description)) return;
          if (err instanceof TelegramError && /message to edit not found|message can't be edited/i.test(err.description)) {
            const sent = await this.tg.call<{ message_id: number }>('sendMessage', params);
            this.record(eventType, entityId, sent.message_id, 'SENT', null);
            return;
          }
          throw err;
        }
        this.record(eventType, entityId, existing.message_id, 'SENT', null);
      } else {
        const sent = await this.tg.call<{ message_id: number }>('sendMessage', params);
        this.record(eventType, entityId, sent.message_id, 'SENT', null);
      }
    } catch (err) {
      this.record(eventType, entityId, null, 'FAILED', redact((err as Error).message).slice(0, 500));
      throw err;
    }
  }

  private async sendReceipt(receiptId: number) {
    if (this.message('receipt_document', receiptId)?.delivery_status === 'SENT') return;
    const receipt = getReceipt(this.ctx, receiptId);
    if (!receipt) throw new Error(`Receipt ${receiptId} missing`);
    let pdf = readReceiptPdf(this.ctx, receipt);
    if (!pdf) {
      await generateReceipt(this.ctx, receiptId, { send: false });
      pdf = readReceiptPdf(this.ctx, getReceipt(this.ctx, receiptId)!);
      if (!pdf) throw new Error('Receipt PDF unavailable');
    }
    const info = this.ctx.db.get<{ session_code: string; total_satang: number }>(
      `SELECT s.session_code, b.total_satang FROM receipts r JOIN payments p ON p.id = r.payment_id
       JOIN bills b ON b.id = p.bill_id JOIN table_sessions s ON s.id = b.session_id WHERE r.id = ?`,
      [receiptId],
    )!;
    try {
      const sent = await this.tg.sendDocument(this.chatId, `${receipt.receipt_number}.pdf`, pdf, `🧾 Receipt <b>${receipt.receipt_number}</b> · ${info.session_code}`);
      this.record('receipt_document', receiptId, sent.message_id, 'SENT', null);
    } catch (err) {
      this.record('receipt_document', receiptId, null, 'FAILED', redact((err as Error).message).slice(0, 500));
      throw err;
    }
  }
}
