/**
 * Operator CLI (no admin dashboard). Run with: npm run admin -- <command> [...args]
 */
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { loadConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { Database } from './db/database.ts';
import { getMenu, menuReadiness, setPrice, updateItemDetails } from './domain/menu.ts';
import { upsertStaff, type Role } from './domain/staff.ts';
import { ensureTables, listTables } from './domain/tables.ts';
import { consoleLogger } from './lib/log.ts';
import { formatBaht, parseBaht } from './lib/money.ts';
import { generateReceipt } from './receipts/service.ts';
import { HttpTelegramClient } from './telegram/api.ts';

const config = loadConfig();
const db = new Database(config.databasePath);
db.migrate();
const ctx: Ctx = { config, db, log: consoleLogger, now: () => new Date(), kick: () => {} };
const tg = new HttpTelegramClient(config.telegram.apiBase, config.telegram.botToken);

const tableUrl = (token: string) => `${config.publicBaseUrl}/t/${token}`;

const commands: Record<string, { usage: string; run: (args: string[]) => Promise<void> | void }> = {
  migrate: { usage: 'migrate', run: () => console.log('Database is up to date.') },

  'tables:ensure': {
    usage: 'tables:ensure <count>',
    run: ([count]) => {
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('count must be 1-500');
      for (const t of ensureTables(ctx, n)) console.log(`Table ${t.display_number}\t${tableUrl(t.permanent_qr_token)}`);
    },
  },

  'tables:list': {
    usage: 'tables:list',
    run: () => {
      for (const t of listTables(db)) console.log(`Table ${t.display_number}\t${t.session_code ?? '-'}\t${t.session_status ?? 'AVAILABLE'}\t${tableUrl(t.permanent_qr_token)}`);
    },
  },

  'qr:sheet': {
    usage: 'qr:sheet [output-dir]',
    run: async ([out = 'qr-codes']) => {
      const dir = path.resolve(out);
      fs.mkdirSync(dir, { recursive: true });
      const tables = listTables(db);
      if (!tables.length) throw new Error('No tables. Run tables:ensure first.');
      // One A6-ish tent card per A4 quarter: 4 per page.
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const pdfPath = path.join(dir, 'table-qr-codes.pdf');
      doc.pipe(fs.createWriteStream(pdfPath));
      const W = doc.page.width / 2;
      const H = doc.page.height / 2;
      for (let i = 0; i < tables.length; i++) {
        const t = tables[i];
        if (i > 0 && i % 4 === 0) doc.addPage();
        const x = (i % 2) * W;
        const y = (Math.floor(i / 2) % 2) * H;
        const url = tableUrl(t.permanent_qr_token);
        const png = await QRCode.toBuffer(url, { errorCorrectionLevel: 'Q', margin: 1, width: 600 });
        fs.writeFileSync(path.join(dir, `table-${t.display_number}.png`), png);
        doc.rect(x + 12, y + 12, W - 24, H - 24).lineWidth(0.5).dash(3, { space: 3 }).stroke().undash();
        doc.font('Helvetica-Bold').fontSize(20).text(config.venue.name, x, y + 40, { width: W, align: 'center' });
        doc.font('Helvetica').fontSize(12).text('Scan to order cocktails', x, y + 68, { width: W, align: 'center' });
        doc.image(png, x + (W - 200) / 2, y + 95, { width: 200 });
        doc.font('Helvetica-Bold').fontSize(30).text(`TABLE ${t.display_number}`, x, y + 310, { width: W, align: 'center' });
        doc.font('Helvetica').fontSize(8).fillColor('#555').text('Ask staff for your table PIN', x, y + 350, { width: W, align: 'center' }).fillColor('black');
      }
      doc.end();
      console.log(`Wrote ${pdfPath} and ${tables.length} PNG(s) to ${dir}`);
    },
  },

  'menu:list': {
    usage: 'menu:list',
    run: () => {
      for (const c of getMenu(db)) {
        console.log(`\n${c.name}`);
        for (const i of c.items) console.log(`  [${i.code}] ${i.name}\t${i.price_satang ? formatBaht(i.price_satang) : 'NO PRICE'}${i.available ? '' : '\t(sold out)'}`);
      }
      const r = menuReadiness(db);
      console.log(r.ready ? '\nAll items priced: ordering enabled.' : `\nOrdering DISABLED. Missing prices: ${r.missing.join(', ')}`);
    },
  },

  'price:set': {
    usage: 'price:set <item code or name> <THB>',
    run: (args) => {
      const thb = args.pop();
      if (!thb || !args.length) throw new Error('usage: price:set <item> <THB>');
      const item = setPrice(ctx, args.join(' '), parseBaht(thb), { type: 'system' });
      console.log(`${item.name} = ${formatBaht(item.price_satang!)}`);
    },
  },

  'price:import': {
    usage: 'price:import <file.json>   (JSON object: { "item code or name": THB, ... })',
    run: ([file]) => {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number | string>;
      db.tx(() => {
        for (const [k, v] of Object.entries(data)) {
          const item = setPrice(ctx, k, parseBaht(String(v)), { type: 'system' });
          console.log(`${item.name} = ${formatBaht(item.price_satang!)}`);
        }
      });
    },
  },

  'item:update': {
    usage: 'item:update <item code> [--image URL] [--description TEXT] [--prep-note TEXT] [--ingredients "Gin, Campari, Sweet vermouth"]',
    run: ([code, ...rest]) => {
      const fields: { description?: string | null; image_url?: string | null; prep_note?: string | null; ingredients?: string[] } = {};
      for (let i = 0; i < rest.length; i += 2) {
        const v = rest[i + 1] === '-' ? null : rest[i + 1];
        if (rest[i] === '--image') fields.image_url = v;
        else if (rest[i] === '--description') fields.description = v;
        else if (rest[i] === '--prep-note') fields.prep_note = v;
        else if (rest[i] === '--ingredients') fields.ingredients = (v ?? '').split(',');
        else throw new Error(`Unknown flag ${rest[i]}`);
      }
      const item = updateItemDetails(ctx, code, fields);
      console.log(`Updated ${item.name}`);
    },
  },

  'staff:add': {
    usage: 'staff:add <telegram user id> <server|cashier|lead> <display name...>',
    run: ([id, role, ...name]) => {
      if (!name.length) throw new Error('display name required');
      upsertStaff(ctx, id, name.join(' '), role as Role, true);
      console.log(`Staff ${name.join(' ')} (${id}) is now ${role}`);
    },
  },

  'staff:deactivate': {
    usage: 'staff:deactivate <telegram user id>',
    run: ([id]) => {
      const s = db.get<{ display_name: string; role: Role }>('SELECT * FROM staff WHERE telegram_user_id = ?', [id]);
      if (!s) throw new Error('No such staff member');
      upsertStaff(ctx, id, s.display_name, s.role, false);
      console.log(`Deactivated ${s.display_name}`);
    },
  },

  'staff:list': {
    usage: 'staff:list',
    run: () => {
      for (const s of db.all('SELECT * FROM staff ORDER BY role, display_name')) console.log(`${s.telegram_user_id}\t${s.role}\t${s.active ? 'active' : 'inactive'}\t${s.display_name}`);
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
      console.log('Webhook set.');
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
      console.log('Commands set.');
    },
  },

  'telegram:info': {
    usage: 'telegram:info',
    run: async () => {
      const me = await tg.call('getMe', {});
      const hook = await tg.call('getWebhookInfo', {});
      console.log({ bot: me.username, webhook: hook.url, pending: hook.pending_update_count, lastError: hook.last_error_message });
    },
  },

  'receipt:regenerate': {
    usage: 'receipt:regenerate <receipt number> [--resend]',
    run: async ([num, flag]) => {
      const r = db.get<{ id: number }>('SELECT id FROM receipts WHERE receipt_number = ?', [num]);
      if (!r) throw new Error('Receipt not found');
      const out = await generateReceipt(ctx, r.id, { send: false });
      if (flag === '--resend') {
        db.run("DELETE FROM telegram_messages WHERE event_type = 'receipt_document' AND entity_id = ?", [r.id]);
        db.run("UPDATE outbox_events SET delivered_at = NULL, attempts = 0, next_retry_at = ? WHERE dedupe_key = ?", [new Date().toISOString(), `receipt:send:${r.id}`]);
        console.log('Receipt queued for re-sending (start/keep the server running to deliver).');
      }
      console.log(`Regenerated ${num}: ${out.key} (${out.bytes} bytes)`);
    },
  },

  'outbox:status': {
    usage: 'outbox:status',
    run: () => {
      for (const e of db.all('SELECT id, event_type, attempts, next_retry_at, last_error FROM outbox_events WHERE delivered_at IS NULL ORDER BY id')) {
        console.log(`#${e.id}\t${e.event_type}\tattempts=${e.attempts}\tnext=${e.next_retry_at}\t${e.last_error ?? ''}`);
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
        console.log('NOT READY:\n- ' + problems.join('\n- '));
        process.exitCode = 1;
      } else console.log('Ready for service.');
    },
  },
};

const [name, ...args] = process.argv.slice(2);
const cmd = commands[name];
if (!cmd) {
  console.log('Usage: npm run admin -- <command>\n\n' + Object.values(commands).map((c) => '  ' + c.usage).join('\n'));
  process.exitCode = name ? 1 : 0;
} else {
  try {
    await cmd.run(args);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
