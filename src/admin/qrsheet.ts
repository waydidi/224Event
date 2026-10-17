import PDFDocument from 'pdfkit';
// Pure-JS QR encoder (no canvas/PNG), so it also runs inside a Cloudflare Worker.
// @ts-expect-error no bundled types for the core module
import QRCodeCore from 'qrcode/lib/core/qrcode.js';

interface QrModules {
  size: number;
  get(row: number, col: number): number;
}

/** Draw a QR code as vector squares (crisp at any print size). */
function drawQr(doc: PDFKit.PDFDocument, text: string, x: number, y: number, size: number) {
  const { modules } = QRCodeCore.create(text, { errorCorrectionLevel: 'Q' }) as { modules: QrModules };
  const quiet = 2; // quiet-zone modules
  const unit = size / (modules.size + quiet * 2);
  doc.rect(x, y, size, size).fill('#ffffff');
  for (let r = 0; r < modules.size; r++) {
    for (let c = 0; c < modules.size; c++) {
      if (modules.get(r, c)) doc.rect(x + (c + quiet) * unit, y + (r + quiet) * unit, unit + 0.15, unit + 0.15);
    }
  }
  doc.fill('#000000');
}

export interface QrTable {
  number: number;
  url: string;
}

/** A4 sheet, four table cards per page, each with the venue name, a QR code and the table number. */
export function renderQrSheetPdf(venueName: string, tables: QrTable[]): Promise<Uint8Array> {
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const chunks: Uint8Array[] = [];
  doc.on('data', (c: Uint8Array) => chunks.push(c));
  const done = new Promise<Uint8Array>((resolve, reject) => {
    doc.on('end', () => {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      resolve(out);
    });
    doc.on('error', reject);
  });
  const W = doc.page.width / 2;
  const H = doc.page.height / 2;
  tables.forEach((t, i) => {
    if (i > 0 && i % 4 === 0) doc.addPage();
    const x = (i % 2) * W;
    const y = (Math.floor(i / 2) % 2) * H;
    doc.rect(x + 12, y + 12, W - 24, H - 24).lineWidth(0.5).dash(3, { space: 3 }).stroke().undash();
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(20).text(venueName, x, y + 40, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(12).text('Scan to order cocktails', x, y + 68, { width: W, align: 'center' });
    drawQr(doc, t.url, x + (W - 210) / 2, y + 92, 210);
    doc.font('Helvetica-Bold').fontSize(30).fillColor('#000000').text(`TABLE ${t.number}`, x, y + 315, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#555').text('Ask staff for your table PIN', x, y + 355, { width: W, align: 'center' }).fillColor('black');
  });
  doc.end();
  return done;
}
