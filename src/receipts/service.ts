import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.ts';
import { audit } from '../domain/audit.ts';
import { enqueue } from '../outbox/outbox.ts';
import { loadReceiptData, type ReceiptRow } from './model.ts';
import { renderReceiptPdf } from './pdf.ts';

export function receiptsDir(ctx: Ctx) {
  return path.join(ctx.config.dataDir, 'receipts');
}

export function getReceipt(ctx: Ctx, id: number) {
  return ctx.db.get<ReceiptRow>('SELECT * FROM receipts WHERE id = ?', [id]);
}

/**
 * (Re)generate the PDF for an existing receipt. Purely a function of the
 * recorded payment and frozen bill, so retries never touch money or sessions.
 */
export async function generateReceipt(ctx: Ctx, receiptId: number, opts: { send: boolean }) {
  const receipt = getReceipt(ctx, receiptId);
  if (!receipt) throw new Error(`Receipt ${receiptId} not found`);
  ctx.db.run('UPDATE receipts SET generation_attempts = generation_attempts + 1 WHERE id = ?', [receiptId]);
  const data = loadReceiptData(ctx.db, ctx.config, receipt);
  const pdf = await renderReceiptPdf(data);
  const key = receipt.pdf_storage_key ?? `${receipt.receipt_number}-${receipt.lookup_token.slice(0, 8)}.pdf`;
  const dir = receiptsDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${key}.tmp`);
  fs.writeFileSync(tmp, pdf);
  fs.renameSync(tmp, path.join(dir, key));
  ctx.db.tx(() => {
    ctx.db.run('UPDATE receipts SET pdf_storage_key = ?, generated_at = ? WHERE id = ?', [key, ctx.now().toISOString(), receiptId]);
    audit(ctx, { type: 'system' }, receipt.generated_at ? 'receipt.regenerate' : 'receipt.generate', 'receipt', receiptId, { receiptNumber: receipt.receipt_number });
    if (opts.send) enqueue(ctx, 'telegram.receipt_document', { receiptId }, `receipt:send:${receiptId}`);
  });
  ctx.kick();
  return { key, bytes: pdf.length };
}

export function readReceiptPdf(ctx: Ctx, receipt: ReceiptRow): Buffer | null {
  if (!receipt.pdf_storage_key) return null;
  const file = path.join(receiptsDir(ctx), path.basename(receipt.pdf_storage_key));
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}
