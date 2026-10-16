import type { Ctx } from '../context.ts';

export type OutboxEventType =
  | 'telegram.order_card'
  | 'telegram.payment_card'
  | 'telegram.receipt_document'
  | 'telegram.text'
  | 'receipt.generate';

/**
 * Durable outbox: rows are written in the same transaction as the state change
 * that caused them, so a notification can never be lost when the change commits
 * (or sent when it rolls back). A dedupe key makes enqueueing idempotent.
 */
export function enqueue(ctx: Ctx, type: OutboxEventType, payload: Record<string, unknown>, dedupeKey?: string) {
  const now = ctx.now().toISOString();
  ctx.db.run(
    `INSERT INTO outbox_events(event_type, payload, dedupe_key, attempts, next_retry_at, created_at)
     VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
    [type, JSON.stringify(payload), dedupeKey ?? null, now, now],
  );
}
