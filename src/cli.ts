/**
 * Operator CLI (no admin dashboard). Run with: npm run admin -- <command> [...args]
 */
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { loadConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { NodeDatabase } from './db/node-engine.ts';
import { getMenu, menuReadiness, setPrice, updateItemDetails } from './domain/menu.ts';
import { upsertStaff, type Role } from './domain/staff.ts';
import { ensureTables, listTables } from './domain/tables.ts';
import { consoleLogger } from './lib/log.ts';
import { formatBaht, parseBaht } from './lib/money.ts';
import { nodeReceiptAssets } from './receipts/assets-node.ts';
import { generateReceipt } from './receipts/service.ts';
import { adminCommands } from './admin/commands.ts';
import { HttpTelegramClient } from './telegram/api.ts';

const config = loadConfig();
const db = new NodeDatabase(config.databasePath);
db.migrate();
const ctx: Ctx = { config, db, log: consoleLogger, now: () => new Date(), receiptAssets: nodeReceiptAssets(config), kick: () => {} };
const tg = new HttpTelegramClient(config.telegram.apiBase, config.telegram.botToken);

const tableUrl = (token: string) => `${config.publicBaseUrl}/t/${token}`;

const nodeOnly: Record<string, { usage: string; run: (args: string[]) => Promise<void> | void }> = {
  'db:backup': {
    usage: 'db:backup <output-file.db>   (consistent snapshot, safe while the server is running)',
    run: ([out]) => {
      if (!out) throw new Error('usage: db:backup <output-file.db>');
      const file = path.resolve(out);
      if (fs.existsSync(file)) throw new Error(`${file} already exists`);
      db.run(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      console.log(`Backup written to ${file}`);
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
};

const commands = {
  ...adminCommands({ ctx, tg, out: console.log, fail: () => { process.exitCode = 1; } }),
  ...nodeOnly,
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
