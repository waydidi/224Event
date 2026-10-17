import type { Ctx } from '../context.ts';
import { audit } from '../domain/audit.ts';
import { enqueue } from '../outbox/outbox.ts';
import { loadReceiptData, type ReceiptRow } from './model.ts';
import { renderReceiptPdf } from './pdf.ts';

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
  const pdf = await renderReceiptPdf(data, ctx.receiptAssets);
  const key = receipt.pdf_storage_key ?? `${receipt.receipt_number}-${receipt.lookup_token.slice(0, 8)}.pdf`;
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO receipt_files(storage_key, data, created_at) VALUES (?, ?, ?) ON CONFLICT(storage_key) DO UPDATE SET data = excluded.data, created_at = excluded.created_at', [key, pdf, ctx.now().toISOString()]);
    ctx.db.run('UPDATE receipts SET pdf_storage_key = ?, generated_at = ? WHERE id = ?', [key, ctx.now().toISOString(), receiptId]);
    audit(ctx, { type: 'system' }, receipt.generated_at ? 'receipt.regenerate' : 'receipt.generate', 'receipt', receiptId, { receiptNumber: receipt.receipt_number });
    if (opts.send) enqueue(ctx, 'telegram.receipt_document', { receiptId }, `receipt:send:${receiptId}`);
  });
  ctx.kick();
  return { key, bytes: pdf.length };
}

export function readReceiptPdf(ctx: Ctx, receipt: ReceiptRow): Uint8Array | null {
  if (!receipt.pdf_storage_key) return null;
  const row = ctx.db.get<{ data: Uint8Array }>('SELECT data FROM receipt_files WHERE storage_key = ?', [receipt.pdf_storage_key]);
  return row ? new Uint8Array(row.data) : null;
}
