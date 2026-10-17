import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { formatAmount } from '../lib/money.ts';
import { formatDate, formatTime } from '../lib/time.ts';
import { code128B } from './code128.ts';
import type { ReceiptData } from './model.ts';

const MM = 72 / 25.4;
const FONT_DIR = path.resolve(import.meta.dirname, '../../assets/fonts');
const FONTS = {
  regular: path.join(FONT_DIR, 'Inter-Regular.otf'),
  medium: path.join(FONT_DIR, 'Inter-Medium.otf'),
  bold: path.join(FONT_DIR, 'Inter-Bold.otf'),
};
type Font = keyof typeof FONTS;

const INK = '#000000';
const SOFT = '#3a3a3a'; // secondary text: still dark enough for thermal heads
const RULE = '#6b6b6b';

export interface ReceiptItem {
  name: string;
  quantity: number;
  unitPriceSatang: number;
  lineTotalSatang: number;
}

/** The receipt font has no CJK glyphs: "33 — 三三" prints as "33". */
const receiptName = (name: string) => name.replace(/[\u3000-\u9fff\uff00-\uffef]+/g, '').replace(/[\s—-]+$/, '').trim() || name;

/** Same item at the same price across several orders prints as one line. */
export function receiptItems(d: ReceiptData): ReceiptItem[] {
  const map = new Map<string, ReceiptItem>();
  for (const l of d.lines) {
    const name = receiptName(l.itemName);
    const key = `${name}\u0000${l.unitPriceSatang}`;
    const cur = map.get(key);
    if (cur) {
      cur.quantity += l.quantity;
      cur.lineTotalSatang += l.lineTotalSatang;
    } else map.set(key, { name, quantity: l.quantity, unitPriceSatang: l.unitPriceSatang, lineTotalSatang: l.lineTotalSatang });
  }
  return [...map.values()];
}

/** Plain-text rendition of the receipt (same content as the PDF), used for tests and logs. */
export function receiptText(d: ReceiptData): string {
  const items = receiptItems(d);
  return [
    d.venueName, ...d.addressLines, d.phone && `Tel ${d.phone}`, d.taxId && `Tax ID ${d.taxId}`, d.title,
    `Table: ${d.sessionCode}`, `Receipt: ${d.receiptNumber}`, `Date: ${formatDate(d.paidAt, d.timeZone)}`,
    `Time: ${formatTime(d.paidAt, d.timeZone)}`, `Cashier: ${d.cashier}`,
    'ITEM AMOUNT',
    ...items.flatMap((i) => [i.name, `${i.quantity} × ${formatBaht2(i.unitPriceSatang)} ${formatAmount(i.lineTotalSatang)}`]),
    ...(d.adjustments.length ? [`Subtotal ${formatAmount(d.subtotalSatang)}`, ...d.adjustments.map((a) => `${a.label} ${formatAmount(a.amountSatang)}`)] : []),
    `TOTAL ${formatBaht2(d.totalSatang)}`, `Payment ${d.paymentMethod}`, `Status ${d.paymentStatus}`,
    'THANK YOU!', 'Please come again', d.receiptNumber,
  ].filter(Boolean).join('\n');
}

/** "฿1,220.00" */
const formatBaht2 = (satang: number) => `฿${formatAmount(satang)}`;

interface Op {
  height: number;
  draw: (doc: PDFKit.PDFDocument, y: number) => void;
}

function registerFonts(doc: PDFKit.PDFDocument) {
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);
}

/**
 * Narrow, continuous, auto-height receipt in the style of a modern thermal
 * slip: logo, venue name and address, info block, itemised lines, total,
 * payment status and a Code 128 barcode of the receipt number.
 */
export async function renderReceiptPdf(d: ReceiptData): Promise<Buffer> {
  const k = d.widthMm === 80 ? 1 : 0.78; // type scale for 58 mm rolls
  const pageWidth = d.widthMm * MM;
  const printable = (d.widthMm === 80 ? 72 : 48) * MM;
  const x0 = (pageWidth - printable) / 2;
  const x1 = x0 + printable;
  const W = printable;
  const size = { name: 14 * k, body: 9 * k, small: 7.5 * k, total: 14 * k };

  // A scratch document for measuring text before the page height is known.
  const m = new PDFDocument({ size: [pageWidth, 1000], margin: 0 });
  registerFonts(m);
  const textHeight = (text: string, font: Font, fontSize: number, width = W) => m.font(font).fontSize(fontSize).heightOfString(text, { width, lineGap: 0 });
  const widthOf = (text: string, font: Font, fontSize: number) => m.font(font).fontSize(fontSize).widthOfString(text);

  const ops: Op[] = [];
  const gap = (h: number) => ops.push({ height: h * k, draw: () => {} });
  const centered = (text: string, font: Font, fontSize: number, color = INK, characterSpacing = 0) => {
    const h = textHeight(text, font, fontSize);
    ops.push({ height: h, draw: (doc, y) => doc.font(font).fontSize(fontSize).fillColor(color).text(text, x0, y, { width: W, align: 'center', characterSpacing }) });
  };
  const rule = (before = 10, after = 10) => {
    gap(before);
    ops.push({ height: 0.8, draw: (doc, y) => doc.moveTo(x0, y + 0.4).lineTo(x1, y + 0.4).lineWidth(0.8).strokeColor(RULE).stroke() });
    gap(after);
  };
  const pair = (left: string, right: string, opts: { lf?: Font; rf?: Font; ls?: number; rs?: number; lc?: string; rc?: string } = {}) => {
    const lf = opts.lf ?? 'regular', rf = opts.rf ?? 'regular';
    const ls = opts.ls ?? size.body, rs = opts.rs ?? size.body;
    const h = Math.max(textHeight(left, lf, ls), textHeight(right, rf, rs));
    ops.push({
      height: h,
      draw: (doc, y) => {
        // Bottom-align the two sides so a big total sits on the same baseline as its label.
        const lh = textHeight(left, lf, ls), rh = textHeight(right, rf, rs);
        doc.font(lf).fontSize(ls).fillColor(opts.lc ?? INK).text(left, x0, y + (h - lh) * 0.8, { lineBreak: false });
        doc.font(rf).fontSize(rs).fillColor(opts.rc ?? INK).text(right, x1 - widthOf(right, rf, rs), y + (h - rh) * 0.8, { lineBreak: false });
      },
    });
  };

  // ---- Header: logo, name, address ---------------------------------------
  const logoSize = 52 * k;
  ops.push({
    height: logoSize,
    draw: (doc, y) => {
      if (d.logoPath && fs.existsSync(d.logoPath)) {
        doc.image(d.logoPath, x0, y, { fit: [W, logoSize], align: 'center', valign: 'center' });
        return;
      }
      // Default mark until the venue's own logo file is configured.
      const r = logoSize / 2;
      const cx = x0 + W / 2;
      doc.circle(cx, y + r, r).fill(INK);
      doc.circle(cx, y + r, r - 2.2 * k).lineWidth(0.7 * k).strokeColor('#ffffff').stroke();
      doc.font('bold').fontSize(15 * k).fillColor('#ffffff');
      const t = '224';
      doc.text(t, cx - widthOf(t, 'bold', 15 * k) / 2, y + r - 15 * k * 0.6, { lineBreak: false });
    },
  });
  gap(8);
  centered(d.venueName.toUpperCase(), 'bold', size.name);
  gap(3);
  for (const line of d.addressLines) centered(line, 'regular', size.small, SOFT);
  if (d.phone) centered(`Tel. ${d.phone}`, 'regular', size.small, SOFT);
  if (d.taxId) centered(`Tax ID ${d.taxId}`, 'regular', size.small, SOFT);
  gap(3);
  centered(d.title.toUpperCase(), 'regular', size.small, SOFT, 0.6 * k);
  rule(12, 12);

  // ---- Info block --------------------------------------------------------
  const info: [string, string][] = [
    ['Table:', d.sessionCode],
    ['Receipt:', d.receiptNumber],
    ['Date:', formatDate(d.paidAt, d.timeZone)],
    ['Time:', formatTime(d.paidAt, d.timeZone)],
    ['Cashier:', d.cashier],
  ];
  const labelW = Math.max(...info.map(([l]) => widthOf(l, 'regular', size.body))) + 14 * k;
  for (const [label, value] of info) {
    const h = textHeight(value, 'regular', size.body, W - labelW) + 2.5 * k;
    ops.push({
      height: h,
      draw: (doc, y) => {
        doc.font('regular').fontSize(size.body).fillColor(INK).text(label, x0, y, { lineBreak: false });
        doc.text(value, x0 + labelW, y, { width: W - labelW });
      },
    });
  }
  rule(10, 12);

  // ---- Items ---------------------------------------------------------------
  pair('ITEM', 'AMOUNT', { lf: 'medium', rf: 'medium', ls: size.body, rs: size.body });
  gap(10);
  const items = receiptItems(d);
  items.forEach((item, i) => {
    centeredLeft(item.name);
    gap(2.5);
    pair(`${item.quantity} × ${formatBaht2(item.unitPriceSatang)}`, formatAmount(item.lineTotalSatang), { lc: SOFT });
    if (i < items.length - 1) gap(10);
  });
  function centeredLeft(text: string) {
    const h = textHeight(text, 'regular', size.body);
    ops.push({ height: h, draw: (doc, y) => doc.font('regular').fontSize(size.body).fillColor(INK).text(text, x0, y, { width: W }) });
  }
  rule(12, 12);

  // ---- Totals --------------------------------------------------------------
  if (d.adjustments.length) {
    pair('Subtotal', formatAmount(d.subtotalSatang), { lc: SOFT });
    gap(5);
    for (const a of d.adjustments) {
      pair(a.label, formatAmount(a.amountSatang), { lc: SOFT });
      gap(5);
    }
    gap(4);
  }
  pair('TOTAL', formatBaht2(d.totalSatang), { lf: 'bold', rf: 'bold', ls: 10 * k, rs: size.total });
  gap(9);
  pair('Payment', d.paymentMethod, { lc: SOFT });
  gap(9);
  pair('Status', d.paymentStatus, { lc: SOFT });
  rule(12, 12);

  // ---- Footer: thanks + barcode ---------------------------------------------
  centered('THANK YOU!', 'medium', size.body);
  gap(3);
  centered('Please come again', 'regular', size.small, SOFT);
  gap(8);
  const modules = code128B(d.receiptNumber);
  const totalModules = modules.reduce((s, w) => s + w, 0);
  const moduleW = Math.min((W * 0.82) / totalModules, 1.5);
  const barH = 26 * k;
  ops.push({
    height: barH,
    draw: (doc, y) => {
      let x = x0 + (W - totalModules * moduleW) / 2;
      modules.forEach((w, i) => {
        if (i % 2 === 0) doc.rect(x, y, w * moduleW, barH);
        x += w * moduleW;
      });
      doc.fill(INK);
    },
  });
  gap(4);
  centered(d.receiptNumber, 'regular', size.small, SOFT);

  const top = 7 * MM;
  const bottom = 10 * MM; // feed / tear-off margin
  const height = top + bottom + ops.reduce((s, o) => s + o.height, 0);

  const doc = new PDFDocument({
    size: [pageWidth, height],
    margin: 0,
    info: { Title: `Receipt ${d.receiptNumber}`, Author: d.venueName, CreationDate: new Date(d.paidAt) },
  });
  registerFonts(doc);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  let y = top;
  for (const op of ops) {
    op.draw(doc, y);
    y += op.height;
  }
  doc.end();
  m.end();
  return done;
}
