import type { Ctx } from '../context.ts';
import type { StaffRow } from './staff.ts';

export type Actor =
  | { type: 'customer'; accessId: number }
  | { type: 'staff'; staff: StaffRow }
  | { type: 'system' }
  | { type: 'unknown'; telegramUserId: string };

export function audit(
  ctx: Ctx,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | number | null,
  metadata: Record<string, unknown> = {},
) {
  const actorId =
    actor.type === 'customer' ? `access:${actor.accessId}`
    : actor.type === 'staff' ? `staff:${actor.staff.id}`
    : actor.type === 'unknown' ? `telegram:${actor.telegramUserId}`
    : null;
  ctx.db.run(
    'INSERT INTO audit_events(actor_type, actor_id, action, entity_type, entity_id, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [actor.type, actorId, action, entityType, entityId === null ? null : String(entityId), ctx.now().toISOString(), JSON.stringify(metadata)],
  );
}
