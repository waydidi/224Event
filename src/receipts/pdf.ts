import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { formatAmount } from '../lib/money.ts';
import { formatDate, formatTime } from '../lib/time.ts';
import type { ReceiptData } from './model.ts';

const MM = 72 / 25.4;

type Line =
  | { kind: 'text'; text: string; align?: 'left' | 'center'; bold?: boolean; size?: number }
  | { kind: 'pair'; left: string; right: string; bold?: boolean; size?: number }
  | { kind: 'rule' }
  | { kind: 'gap'; height: number }
  | { kind: 'qr'; content: string };

interface Geometry {
  pageWidth: number;
  margin: number;
  contentWidth: number;
  fontSize: number;
  cols: number;
}

export function geometry(widthMm: 80 | 58): Geometry {
  const pageWidth = widthMm * MM;
  // 80 mm rolls print ~72 mm; 58 mm rolls ~48 mm. Keep content inside that.
  const printable = (widthMm === 80 ? 72 : 48) * MM;
  const margin = (pageWidth - printable) / 2;
  const fontSize = widthMm === 80 ? 8.5 : 7.5;
  const cols = Math.floor(printable / (fontSize * 0.6)); // Courier advance = 0.6em
  return { pageWidth, margin, contentWidth: printable, fontSize, cols };
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > width) {
      if (cur) out.push(cur);
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
      cur = out.pop()!;
      continue;
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ' ' + word;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** Build the receipt as a list of monospace lines (pure; unit-testable). */
export function receiptLines(d: ReceiptData, cols: number): Line[] {
  const L: Line[] = [];
  const center = (text: string, bold = false, size?: number) => wrap(text, Math.floor(cols / (size ?? 1))).forEach((t) => L.push({ kind: 'text', text: t, align: 'center', bold, size }));
  center(d.venueName, true, 1.5);
  d.addressLines.forEach((a) => center(a));
  if (d.phone) center(`Tel: ${d.phone}`);
  if (d.taxId) center(`Tax ID: ${d.taxId}`);
  L.push({ kind: 'gap', height: 4 });
  center(d.title, true);
  L.push({ kind: 'rule' });
  L.push({ kind: 'pair', left: 'Receipt:', right: d.receiptNumber });
  L.push({ kind: 'pair', left: 'Table:', right: `${d.tableNumber} (${d.sessionCode})` });
  L.push({ kind: 'pair', left: 'Bill:', right: d.billNumber });
  L.push({ kind: 'pair', left: 'Date:', right: `${formatDate(d.paidAt, d.timeZone)} ${formatTime(d.paidAt, d.timeZone)}` });
  L.push({ kind: 'pair', left: 'Cashier:', right: d.cashier.slice(0, Math.max(8, cols - 10)) });
  L.push({ kind: 'rule' });

  let lastOrder = '';
  for (const line of d.lines) {
    if (line.orderNumber !== lastOrder) {
      L.push({ kind: 'text', text: line.orderNumber, bold: true });
      lastOrder = line.orderNumber;
    }
    const amount = formatAmount(line.lineTotalSatang);
    const nameWidth = cols - amount.length - 1;
    const parts = wrap(`${line.quantity} x ${line.itemName}`, nameWidth);
    L.push({ kind: 'pair', left: parts[0], right: amount });
    parts.slice(1).forEach((p) => L.push({ kind: 'text', text: '    ' + p }));
    L.push({ kind: 'text', text: `    @ ${formatAmount(line.unitPriceSatang)}`, size: 0.9 });
  }
  L.push({ kind: 'rule' });
  L.push({ kind: 'pair', left: 'Subtotal', right: formatAmount(d.subtotalSatang) });
  for (const a of d.adjustments) L.push({ kind: 'pair', left: a.label, right: formatAmount(a.amountSatang) });
  L.push({ kind: 'pair', left: 'TOTAL THB', right: formatAmount(d.totalSatang), bold: true, size: 1.25 });
  L.push({ kind: 'gap', height: 2 });
  L.push({ kind: 'pair', left: 'Payment:', right: d.paymentMethod });
  L.push({ kind: 'pair', left: 'Status:', right: d.paymentStatus });
  L.push({ kind: 'rule' });
  L.push({ kind: 'gap', height: 4 });
  center('THANK YOU!', true, 1.25);
  L.push({ kind: 'gap', height: 6 });
  L.push({ kind: 'qr', content: d.qrContent });
  center(`Receipt ID ${d.lookupToken.slice(0, 12)}`, false, 0.8);
  return L;
}

function lineHeight(l: Line, g: Geometry, qrSize: number): number {
  switch (l.kind) {
    case 'gap': return l.height;
    case 'rule': return g.fontSize * 1.1;
    case 'qr': return qrSize + 4;
    default: return g.fontSize * (l.size ?? 1) * 1.3;
  }
}

/** Render a continuous, auto-height thermal-style PDF (monochrome, Courier). */
export async function renderReceiptPdf(d: ReceiptData): Promise<Buffer> {
  const g = geometry(d.widthMm);
  const lines = receiptLines(d, g.cols);
  const qr = QRCode.create(d.qrContent, { errorCorrectionLevel: 'M' });
  const qrSize = Math.min(g.contentWidth * 0.5, 30 * MM);
  const top = 6 * MM;
  const bottom = 10 * MM; // feed/tear margin
  const height = top + bottom + lines.reduce((s, l) => s + lineHeight(l, g, qrSize), 0);

  const doc = new PDFDocument({
    size: [g.pageWidth, height],
    margin: 0,
    info: { Title: `Receipt ${d.receiptNumber}`, Author: d.venueName, CreationDate: new Date(d.paidAt) },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.fillColor('black').strokeColor('black');
  let y = top;
  const x = g.margin;
  for (const l of lines) {
    const h = lineHeight(l, g, qrSize);
    if (l.kind === 'rule') {
      doc.moveTo(x, y + h / 2).lineTo(x + g.contentWidth, y + h / 2).dash(2, { space: 1.5 }).lineWidth(0.6).stroke().undash();
    } else if (l.kind === 'qr') {
      const n = qr.modules.size;
      const cell = qrSize / n;
      const qx = x + (g.contentWidth - qrSize) / 2;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) doc.rect(qx + c * cell, y + r * cell, cell + 0.05, cell + 0.05);
      doc.fill('black');
    } else if (l.kind === 'text' || l.kind === 'pair') {
      const size = g.fontSize * (l.size ?? 1);
      doc.font(l.bold ? 'Courier-Bold' : 'Courier').fontSize(size);
      if (l.kind === 'text') {
        doc.text(l.text, x, y, { width: g.contentWidth, align: l.align ?? 'left', lineBreak: false });
      } else {
        doc.text(l.left, x, y, { lineBreak: false });
        const w = doc.widthOfString(l.right);
        doc.text(l.right, x + g.contentWidth - w, y, { lineBreak: false });
      }
    }
    y += h;
  }
  doc.end();
  return done;
}
