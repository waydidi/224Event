import type { Ctx } from '../context.ts';
import { AppError, conflict, gone, notFound, unauthorized } from '../lib/errors.ts';
import { randomToken, safeEqual, sha256 } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { getActiveSession, getSession, getTableById, getTableByQrToken, type SessionRow, type TableRow } from './tables.ts';

export interface AccessRow {
  id: number;
  session_id: number;
  hashed_visit_token: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface CustomerAuth {
  access: AccessRow;
  session: SessionRow;
  table: TableRow;
  /** True only while this token's session is still the table's active session. */
  isCurrent: boolean;
}

/**
 * Exchange the permanent table QR + the staff-issued session PIN for a
 * short-lived visit token bound to exactly one session. The QR alone never
 * grants access: a new round always requires the new PIN.
 */
export function joinSession(ctx: Ctx, qrToken: string, pin: string) {
  const table = getTableByQrToken(ctx.db, qrToken);
  if (!table) throw notFound('TABLE_NOT_FOUND', 'Unknown table');
  const outcome = ctx.db.tx(() => {
    const session = getActiveSession(ctx.db, table);
    if (!session) return { error: conflict('NO_ACTIVE_SESSION', 'This table is waiting for staff to open it.') };
    const max = ctx.config.access.pinMaxFailedAttempts;
    if (session.pin_failed_attempts >= max) {
      return { error: new AppError(423, 'PIN_LOCKED', 'Too many incorrect PINs. Please ask staff for a new PIN.') };
    }
    if (!/^\d+$/.test(pin) || !safeEqual(pin, session.join_pin)) {
      ctx.db.run('UPDATE table_sessions SET pin_failed_attempts = pin_failed_attempts + 1 WHERE id = ?', [session.id]);
      audit(ctx, { type: 'system' }, 'session.join_failed', 'session', session.id, { attempts: session.pin_failed_attempts + 1 });
      // Committed (not rolled back) so the attempt counter actually counts.
      return { error: unauthorized('INVALID_PIN', 'Incorrect PIN. Please check with staff.') };
    }
    const token = randomToken(32);
    const issued = ctx.now();
    const expires = new Date(issued.getTime() + ctx.config.access.visitTokenTtlHours * 3600_000);
    const res = ctx.db.run('INSERT INTO session_access(session_id, hashed_visit_token, issued_at, expires_at) VALUES (?, ?, ?, ?)', [
      session.id, sha256(token), issued.toISOString(), expires.toISOString(),
    ]);
    audit(ctx, { type: 'customer', accessId: Number(res.lastInsertRowid) }, 'session.join', 'session', session.id);
    return { token, session, expiresAt: expires.toISOString() };
  });
  if ('error' in outcome) throw outcome.error;
  return { visitToken: outcome.token, sessionCode: outcome.session.session_code, expiresAt: outcome.expiresAt };
}

export function authenticate(ctx: Ctx, bearer: string | undefined): CustomerAuth {
  if (!bearer) throw unauthorized('NO_VISIT_TOKEN', 'Please join the table first.');
  const access = ctx.db.get<AccessRow>('SELECT * FROM session_access WHERE hashed_visit_token = ?', [sha256(bearer)]);
  if (!access || access.revoked_at) throw unauthorized('INVALID_VISIT_TOKEN', 'Your table access is no longer valid. Please scan the QR again.');
  if (new Date(access.expires_at).getTime() <= ctx.now().getTime()) {
    throw unauthorized('VISIT_TOKEN_EXPIRED', 'Your table access has expired. Please scan the QR again.');
  }
  const session = getSession(ctx.db, access.session_id)!;
  const table = getTableById(ctx.db, session.table_id);
  const isCurrent = table.current_session_id === session.id && (session.status === 'OPEN' || session.status === 'PAYMENT_REQUESTED');
  return { access, session, table, isCurrent };
}

/** Throws unless the token's session is still the table's live session. */
export function requireCurrent(auth: CustomerAuth) {
  if (!auth.isCurrent) throw gone('SESSION_ENDED', `Session ${auth.session.session_code} has ended.`);
}
