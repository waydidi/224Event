import type { Ctx } from '../context.ts';
import type { Database } from '../db/database.ts';
import { randomToken } from '../lib/ids.ts';

export type ActionKind = 'order.serve' | 'payment.confirm' | 'bill.reopen' | 'table.open' | 'table.pin';

export interface CallbackAction {
  id: string;
  action: ActionKind;
  entity_type: string;
  entity_id: number;
  payload: string;
}

/**
 * Telegram callback_data carries only this opaque, random reference. Everything
 * the action needs (and its authority) is resolved server-side from the DB.
 */
export function createAction(ctx: Ctx, action: ActionKind, entityType: string, entityId: number, payload: Record<string, unknown> = {}): string {
  const id = randomToken(15); // 20 chars; callback_data limit is 64 bytes
  ctx.db.run('INSERT INTO callback_actions(id, action, entity_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id, action, entityType, entityId, JSON.stringify(payload), ctx.now().toISOString(),
  ]);
  return id;
}

export function findAction(db: Database, id: string): CallbackAction | undefined {
  return db.get<CallbackAction>('SELECT * FROM callback_actions WHERE id = ?', [id]);
}

export function findActionsFor(db: Database, entityType: string, entityId: number): CallbackAction[] {
  return db.all<CallbackAction>('SELECT * FROM callback_actions WHERE entity_type = ? AND entity_id = ? ORDER BY rowid', [entityType, entityId]);
}
