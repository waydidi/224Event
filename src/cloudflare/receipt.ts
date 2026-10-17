import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import regularBytes from "../../assets/fonts/Inter-Receipt-Regular.ttf";
import boldBytes from "../../assets/fonts/Inter-Receipt-Bold.ttf";
import logoBytes from "../../assets/receipt-logo.png";
import type { ReceiptRow, ReceiptData } from "../receipts/model.ts";
import { code128B } from "../receipts/code128.ts";
import { formatAmount } from "../lib/money.ts";
import { formatDate, formatTime } from "../lib/time.ts";
import { sha256 } from "../lib/ids.ts";
import {
  audit,
  enqueue,
  frozenBillView,
  getBill,
  getSession,
  getTableById,
  stamp,
  type Ctx,
} from "./domain.ts";

export async function receiptData(c: Ctx, r: ReceiptRow): Promise<ReceiptData> {
  const p = (await c.db.get<any>("SELECT * FROM payments WHERE id=?", [
    r.payment_id,
  ]))!;
  const bill = (await getBill(c.db, p.bill_id))!,
    view = await frozenBillView(c.db, bill),
    s = (await getSession(c.db, bill.session_id))!,
    t = (await getTableById(c.db, s.table_id))!;
  const cashier = (await c.db.get<{ display_name: string }>(
    "SELECT display_name FROM staff WHERE id=?",
    [p.confirmed_by],
  ))!;
  return {
    widthMm: r.width_mm === 58 ? 58 : 80,
    logoPath: "",
    venueName: c.config.venue.name,
    addressLines: c.config.venue.addressLines,
    phone: c.config.venue.phone,
    taxId: c.config.venue.taxId,
    title: c.config.receipt.title,
    receiptNumber: r.receipt_number,
    tableNumber: t.display_number,
    sessionCode: s.session_code,
    billNumber: bill.bill_number,
    orderNumbers: view.orderNumbers,
    paidAt: p.confirmed_at,
    cashier: cashier.display_name,
    lines: view.lines,
    subtotalSatang: view.subtotalSatang,
    adjustments: view.adjustments,
    totalSatang: p.amount_satang,
    paymentMethod: p.method,
    paymentStatus: "PAID",
    lookupToken: r.lookup_token,
    qrContent: c.config.receipt.customerDownload
      ? `${c.config.publicBaseUrl}/api/public/receipt/${r.lookup_token}`
      : r.lookup_token,
    timeZone: c.config.displayTimeZone,
  };
}
export async function renderPdf(d: ReceiptData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${d.receiptNumber} · ${d.sessionCode}`);
  pdf.setProducer("224 Live House");
  const font = await pdf.embedFont(regularBytes, { subset: false }),
    bold = await pdf.embedFont(boldBytes, { subset: false }),
    logo = await pdf.embedPng(logoBytes);
  const width = (d.widthMm * 72) / 25.4,
    margin = d.widthMm === 80 ? 12 : 10,
    usable = width - 2 * margin,
    scale = d.widthMm === 80 ? 1 : 0.82;
  type Line = {
    text: string;
    size: number;
    bold: boolean;
    center: boolean;
    gap?: number;
  };
  const lines: Line[] = [];
  const clean = (s: string) =>
    [...s.replace(/[\u3000-\u9fff\uff00-\uffef]+/g, "")]
      .filter((ch) => font.getCharacterSet().includes(ch.codePointAt(0)!))
      .join("");
  const add = (value: string, size = 9, heavy = false, center = false) => {
    const text = clean(value),
      face = heavy ? bold : font,
      pt = size * scale;
    let current = "";
    for (const char of text) {
      if (current && face.widthOfTextAtSize(current + char, pt) > usable) {
        lines.push({ text: current, size: pt, bold: heavy, center });
        current = "";
      }
      current += char;
    }
    lines.push({ text: current, size: pt, bold: heavy, center });
  };
  const rule = () =>
    lines.push({
      text: "",
      size: 3,
      bold: false,
      center: false,
      gap: 9 * scale,
    });
  add(d.venueName, 13, true, true);
  for (const text of d.addressLines) add(text, 7, false, true);
  if (d.phone) add(`Tel ${d.phone}`, 7, false, true);
  if (d.taxId) add(`Tax ID ${d.taxId}`, 7, false, true);
  add(d.title, 10, true, true);
  rule();
  add(`Table: ${d.sessionCode}`, 10, true);
  add(`Receipt: ${d.receiptNumber}`);
  add(`Bill: ${d.billNumber}`, 8);
  add(
    `Date: ${formatDate(d.paidAt, d.timeZone)}  ${formatTime(d.paidAt, d.timeZone)}`,
    7,
  );
  add(`Cashier: ${d.cashier}`, 8);
  rule();
  const merged = new Map<
    string,
    { name: string; qty: number; unit: number; total: number }
  >();
  for (const l of d.lines) {
    const key = `${l.itemName}:${l.unitPriceSatang}`,
      v = merged.get(key) ?? {
        name: l.itemName,
        qty: 0,
        unit: l.unitPriceSatang,
        total: 0,
      };
    v.qty += l.quantity;
    v.total += l.lineTotalSatang;
    merged.set(key, v);
  }
  add("ITEM / AMOUNT", 8, true);
  for (const l of merged.values()) {
    add(l.name, 9, true);
    add(
      `${l.qty} × ฿${formatAmount(l.unit)}      ฿${formatAmount(l.total)}`,
      8,
    );
  }
  rule();
  if (d.adjustments.length) {
    add(`Subtotal  ฿${formatAmount(d.subtotalSatang)}`);
    for (const a of d.adjustments)
      add(`${a.label}  ฿${formatAmount(a.amountSatang)}`, 8);
  }
  add(`TOTAL  ฿${formatAmount(d.totalSatang)}`, 14, true);
  add(`Payment: ${d.paymentMethod}`, 9);
  add(`Status: ${d.paymentStatus}`, 9, true);
  rule();
  add("THANK YOU!", 11, true, true);
  add("Please come again", 8, false, true);
  const logoHeight = 42 * scale,
    top = margin + logoHeight + 9,
    bottom = 65 * scale;
  const height =
    top +
    lines.reduce((n, l) => n + (l.gap ?? l.size * 1.5), 0) +
    bottom +
    margin;
  const page = pdf.addPage([width, height]);
  let y = height - margin;
  const logoWidth = (logo.width / logo.height) * logoHeight;
  page.drawImage(logo, {
    x: (width - logoWidth) / 2,
    y: y - logoHeight,
    width: logoWidth,
    height: logoHeight,
  });
  y -= logoHeight + 9;
  for (const l of lines) {
    if (l.gap) {
      y -= l.gap / 2;
      page.drawLine({
        start: { x: margin, y },
        end: { x: width - margin, y },
        thickness: 0.5,
        color: rgb(0.4, 0.4, 0.4),
      });
      y -= l.gap / 2;
      continue;
    }
    const face = l.bold ? bold : font;
    y -= l.size * 1.5;
    page.drawText(l.text, {
      x: l.center
        ? (width - face.widthOfTextAtSize(l.text, l.size)) / 2
        : margin,
      y,
      size: l.size,
      font: face,
      color: rgb(0, 0, 0),
    });
  }
  const bars = code128B(d.receiptNumber),
    modules = bars.reduce((s, b) => s + b, 0),
    unit = usable / (modules + 20);
  let x = margin + 10 * unit;
  bars.forEach((w, i) => {
    if (i % 2 === 0)
      page.drawRectangle({
        x,
        y: margin + 23 * scale,
        width: w * unit,
        height: 27 * scale,
        color: rgb(0, 0, 0),
      });
    x += w * unit;
  });
  page.drawText(d.receiptNumber, {
    x: (width - font.widthOfTextAtSize(d.receiptNumber, 8 * scale)) / 2,
    y: margin + 10 * scale,
    size: 8 * scale,
    font,
  });
  return pdf.save();
}
export async function generateReceipt(c: Ctx, id: number, send: boolean) {
  const receipt = await c.db.get<ReceiptRow>(
    "SELECT * FROM receipts WHERE id=?",
    [id],
  );
  if (!receipt) throw new Error("Receipt missing");
  // Retry uses the same persisted PDF, so storage and delivery are independent.
  let stored = await c.db.get<{ pdf: number[] }>(
    "SELECT pdf FROM receipt_pdfs WHERE receipt_id=?",
    [id],
  );
  const pdf = stored
    ? new Uint8Array(stored.pdf)
    : await renderPdf(await receiptData(c, receipt));
  await c.db.transaction(async (tx) => {
    tx.run(
      "INSERT INTO receipt_pdfs(receipt_id,pdf,sha256,created_at) VALUES (?,?,?,?) ON CONFLICT(receipt_id) DO NOTHING",
      [
        id,
        pdf.buffer as ArrayBuffer,
        sha256(Buffer.from(pdf).toString("base64")),
        stamp(c),
      ],
    );
    tx.run(
      "UPDATE receipts SET pdf_storage_key=?,generated_at=COALESCE(generated_at,?),generation_attempts=generation_attempts+1 WHERE id=?",
      [`d1:${id}`, stamp(c), id],
    );
    audit(tx, c, { type: "system" }, "receipt.generate", "receipt", id);
    if (send)
      enqueue(
        tx,
        c,
        "telegram.receipt_document",
        { receiptId: id },
        `receipt:send:${id}`,
      );
  });
  return { bytes: pdf.length, key: `d1:${id}` };
}
export async function readPdf(c: Ctx, id: number) {
  const stored = await c.db.get<{ pdf: number[] }>(
    "SELECT pdf FROM receipt_pdfs WHERE receipt_id=?",
    [id],
  );
  return stored ? new Uint8Array(stored.pdf) : null;
}
