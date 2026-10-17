/**
 * Operator commands that work on any runtime (Node CLI and the Cloudflare Worker admin endpoint).
 * Commands that need local files (db:backup, price:import, qr:sheet) live in cli.ts.
 */
import type { Ctx } from '../context.ts';
import { getMenu, menuReadiness, setPrice, updateItemDetails } from '../domain/menu.ts';
import { upsertStaff, type Role } from '../domain/staff.ts';
import { ensureTables, listTables } from '../domain/tables.ts';
import { formatBaht, parseBaht } from '../lib/money.ts';
import { generateReceipt } from '../receipts/service.ts';
import type { HttpTelegramClient } from '../telegram/api.ts';

export interface AdminEnv {
  ctx: Ctx;
  tg: Pick<HttpTelegramClient, 'call'>;
  out: (line: unknown) => void;
  fail: () => void;
}

export interface AdminCommand {
  usage: string;
  run: (args: string[]) => Promise<void> | void;
}

export function adminCommands({ ctx, tg, out, fail }: AdminEnv): Record<string, AdminCommand> {
  const { db, config } = ctx;
  const tableUrl = (token: string) => `${config.publicBaseUrl}/t/${token}`;
  return {
  migrate: { usage: 'migrate', run: () => out('Database is up to date.') },
  'tables:ensure': {
    usage: 'tables:ensure <count>',
    run: ([count]) => {
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('count must be 1-500');
      for (const t of ensureTables(ctx, n)) out(`Table ${t.display_number}\t${tableUrl(t.permanent_qr_token)}`);
    },
  },
  'tables:list': {
    usage: 'tables:list',
    run: () => {
      for (const t of listTables(db)) out(`Table ${t.display_number}\t${t.session_code ?? '-'}\t${t.session_status ?? 'AVAILABLE'}\t${tableUrl(t.permanent_qr_token)}`);
    },
  },
  'menu:list': {
    usage: 'menu:list',
    run: () => {
      for (const c of getMenu(db)) {
        out(`\n${c.name}`);
        for (const i of c.items) out(`  [${i.code}] ${i.name}\t${i.price_satang ? formatBaht(i.price_satang) : 'NO PRICE'}${i.available ? '' : '\t(sold out)'}`);
      }
      const r = menuReadiness(db);
      out(r.ready ? '\nAll items priced: ordering enabled.' : `\nOrdering DISABLED. Missing prices: ${r.missing.join(', ')}`);
    },
  },
  'price:set': {
    usage: 'price:set <item code or name> <THB>',
    run: (args) => {
      const thb = args.pop();
      if (!thb || !args.length) throw new Error('usage: price:set <item> <THB>');
      const item = setPrice(ctx, args.join(' '), parseBaht(thb), { type: 'system' });
      out(`${item.name} = ${formatBaht(item.price_satang!)}`);
    },
  },
  'item:update': {
    usage: 'item:update <item code> [--image URL] [--thumb URL] [--full URL] [--description TEXT] [--prep-note TEXT] [--ingredients "Gin, Campari, Sweet vermouth"]',
    run: ([code, ...rest]) => {
      const fields: { description?: string | null; image_url?: string | null; thumb_url?: string | null; full_url?: string | null; prep_note?: string | null; ingredients?: string[] } = {};
      for (let i = 0; i < rest.length; i += 2) {
        const v = rest[i + 1] === '-' ? null : rest[i + 1];
        if (rest[i] === '--image') fields.image_url = v;
        else if (rest[i] === '--thumb') fields.thumb_url = v;
        else if (rest[i] === '--full') fields.full_url = v;
        else if (rest[i] === '--description') fields.description = v;
        else if (rest[i] === '--prep-note') fields.prep_note = v;
        else if (rest[i] === '--ingredients') fields.ingredients = (v ?? '').split(',');
        else throw new Error(`Unknown flag ${rest[i]}`);
      }
      const item = updateItemDetails(ctx, code, fields);
      out(`Updated ${item.name}`);
    },
  },
  'staff:add': {
    usage: 'staff:add <telegram user id> <server|cashier|lead> <display name...>',
    run: ([id, role, ...name]) => {
      if (!name.length) throw new Error('display name required');
      upsertStaff(ctx, id, name.join(' '), role as Role, true);
      out(`Staff ${name.join(' ')} (${id}) is now ${role}`);
    },
  },
  'staff:deactivate': {
    usage: 'staff:deactivate <telegram user id>',
    run: ([id]) => {
      const s = db.get<{ display_name: string; role: Role }>('SELECT * FROM staff WHERE telegram_user_id = ?', [id]);
      if (!s) throw new Error('No such staff member');
      upsertStaff(ctx, id, s.display_name, s.role, false);
      out(`Deactivated ${s.display_name}`);
    },
  },
  'staff:list': {
    usage: 'staff:list',
    run: () => {
      for (const s of db.all('SELECT * FROM staff ORDER BY role, display_name')) out(`${s.telegram_user_id}\t${s.role}\t${s.active ? 'active' : 'inactive'}\t${s.display_name}`);
    },
  },
  'telegram:set-webhook': {
    usage: 'telegram:set-webhook',
    run: async () => {
      if (!config.telegram.webhookSecret) throw new Error('Set TELEGRAM_WEBHOOK_SECRET first');
      if (!config.publicBaseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must be https:// for Telegram webhooks');
      await tg.call('setWebhook', {
        url: `${config.publicBaseUrl}/api/integrations/telegram/webhook`,
        secret_token: config.telegram.webhookSecret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      });
      out('Webhook set.');
    },
  },
  'telegram:set-commands': {
    usage: 'telegram:set-commands',
    run: async () => {
      await tg.call('setMyCommands', {
        commands: [
          { command: 'tables', description: 'Tables & sessions' },
          { command: 'open_table', description: 'Open next session: /open_table 1' },
          { command: 'pin', description: 'New join PIN: /pin 1' },
          { command: 'bill', description: 'Current bill: /bill 1' },
          { command: 'reopen_bill', description: 'Reopen pending bill: /reopen_bill 1' },
          { command: 'close_table', description: 'Close empty session: /close_table 1' },
          { command: 'menu', description: 'Menu & availability' },
          { command: 'soldout', description: 'Mark item sold out' },
          { command: 'restock', description: 'Mark item available' },
          { command: 'whoami', description: 'Show your Telegram ID' },
          { command: 'help', description: 'Help' },
        ],
      });
      out('Commands set.');
    },
  },
  'telegram:info': {
    usage: 'telegram:info',
    run: async () => {
      const me = await tg.call('getMe', {});
      const hook = await tg.call('getWebhookInfo', {});
      out({ bot: me.username, webhook: hook.url, pending: hook.pending_update_count, lastError: hook.last_error_message });
    },
  },
  'receipt:regenerate': {
    usage: 'receipt:regenerate <receipt number> [--resend]',
    run: async ([num, flag]) => {
      const r = db.get<{ id: number }>('SELECT id FROM receipts WHERE receipt_number = ?', [num]);
      if (!r) throw new Error('Receipt not found');
      const res = await generateReceipt(ctx, r.id, { send: false });
      if (flag === '--resend') {
        db.run("DELETE FROM telegram_messages WHERE event_type = 'receipt_document' AND entity_id = ?", [r.id]);
        db.run("UPDATE outbox_events SET delivered_at = NULL, attempts = 0, next_retry_at = ? WHERE dedupe_key = ?", [new Date().toISOString(), `receipt:send:${r.id}`]);
        out('Receipt queued for re-sending (start/keep the server running to deliver).');
      }
      out(`Regenerated ${num}: ${res.key} (${res.bytes} bytes)`);
    },
  },
  'outbox:status': {
    usage: 'outbox:status',
    run: () => {
      for (const e of db.all('SELECT id, event_type, attempts, next_retry_at, last_error FROM outbox_events WHERE delivered_at IS NULL ORDER BY id')) {
        out(`#${e.id}\t${e.event_type}\tattempts=${e.attempts}\tnext=${e.next_retry_at}\t${e.last_error ?? ''}`);
      }
    },
  },
  check: {
    usage: 'check   (production readiness)',
    run: () => {
      const problems: string[] = [];
      const r = menuReadiness(db);
      if (!r.ready) problems.push(`Missing prices: ${r.missing.join(', ')}`);
      if (!listTables(db).length) problems.push('No tables provisioned');
      if (!config.telegram.botToken) problems.push('TELEGRAM_BOT_TOKEN not set');
      if (!config.telegram.staffChatId) problems.push('TELEGRAM_STAFF_CHAT_ID not set');
      if (!config.telegram.webhookSecret) problems.push('TELEGRAM_WEBHOOK_SECRET not set');
      if (!config.publicBaseUrl.startsWith('https://')) problems.push('PUBLIC_BASE_URL is not https://');
      const cashiers = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM staff WHERE active = 1 AND role IN ('cashier','lead')")!.c;
      if (!cashiers) problems.push('No active cashier/lead staff');
      if (problems.length) {
        out('NOT READY:\n- ' + problems.join('\n- '));
        fail();
      } else out('Ready for service.');
    },
  },
  };
}
