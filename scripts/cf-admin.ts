/**
 * Operator helper for the Cloudflare deployment (there is no shell on a Worker).
 *
 *   ADMIN_URL=https://orders.224livehouse.com ADMIN_TOKEN=<INTERNAL_API_TOKEN> npm run cf:admin -- tables:ensure 7
 *   npm run cf:admin -- qr                 # downloads table-qr-codes.pdf
 *   npm run cf:admin -- help               # list commands
 */
import fs from 'node:fs';

const url = (process.env.ADMIN_URL ?? '').replace(/\/+$/, '');
const token = process.env.ADMIN_TOKEN ?? '';
if (!url || !token) {
  console.error('Set ADMIN_URL (e.g. https://orders.224livehouse.com) and ADMIN_TOKEN (your INTERNAL_API_TOKEN secret).');
  process.exit(1);
}
const [command, ...args] = process.argv.slice(2);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

if (command === 'qr') {
  const res = await fetch(`${url}/api/internal/qr-sheet.pdf`, { headers });
  if (!res.ok) {
    console.error(`Failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  fs.writeFileSync('table-qr-codes.pdf', Buffer.from(await res.arrayBuffer()));
  console.log('Saved table-qr-codes.pdf (4 table cards per A4 page).');
} else {
  const res = await fetch(`${url}/api/internal/admin`, { method: 'POST', headers, body: JSON.stringify({ command: command === 'help' || !command ? '?' : command, args }) });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; output?: string[]; error?: string; commands?: string[] };
  if (data.commands) console.log('Commands:\n  ' + data.commands.join('\n  ') + '\n  qr   (download the QR code PDF)');
  for (const line of data.output ?? []) console.log(line);
  if (data.error && !data.commands) console.error(`Error: ${data.error}`);
  if (!res.ok || data.ok === false) process.exitCode = data.commands && (command === 'help' || !command) ? 0 : 1;
}
