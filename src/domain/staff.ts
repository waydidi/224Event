import type { Ctx } from '../context.ts';
import type { Database } from '../db/database.ts';
import { audit } from './audit.ts';

export type Role = 'server' | 'cashier' | 'lead';

export interface StaffRow {
  id: number;
  telegram_user_id: string;
  display_name: string;
  role: Role;
  active: number;
}

export type Permission =
  | 'order.serve'
  | 'table.view'
  | 'table.open'
  | 'table.pin'
  | 'table.close_empty'
  | 'bill.reopen'
  | 'payment.confirm'
  | 'menu.availability'
  | 'session.void';

const grants: Record<Role, Permission[]> = {
  server: ['order.serve', 'table.view'],
  cashier: ['order.serve', 'table.view', 'table.open', 'table.pin', 'table.close_empty', 'bill.reopen', 'payment.confirm', 'menu.availability'],
  lead: ['order.serve', 'table.view', 'table.open', 'table.pin', 'table.close_empty', 'bill.reopen', 'payment.confirm', 'menu.availability', 'session.void'],
};

export function can(staff: StaffRow | undefined, permission: Permission): staff is StaffRow {
  return !!staff && staff.active === 1 && grants[staff.role].includes(permission);
}

export function findActiveStaff(db: Database, telegramUserId: string | number): StaffRow | undefined {
  return db.get<StaffRow>('SELECT * FROM staff WHERE telegram_user_id = ? AND active = 1', [String(telegramUserId)]);
}

export function upsertStaff(ctx: Ctx, telegramUserId: string, displayName: string, role: Role, active = true) {
  if (!/^\d{1,20}$/.test(telegramUserId)) throw new Error('Telegram user ID must be numeric');
  if (!['server', 'cashier', 'lead'].includes(role)) throw new Error('Role must be server, cashier or lead');
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO staff(telegram_user_id, display_name, role, active, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, active = excluded.active`,
      [telegramUserId, displayName, role, active ? 1 : 0, ctx.now().toISOString()],
    );
    audit(ctx, { type: 'system' }, 'staff.upsert', 'staff', telegramUserId, { role, active, displayName });
  });
}
