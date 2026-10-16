import type { Config } from '../config.ts';
import type { Database } from '../db/database.ts';
import { frozenBillView, getBill, type Adjustment, type BillLine } from '../domain/billing.ts';
import type { PaymentRow } from '../domain/payments.ts';
import { getSession, getTableById } from '../domain/tables.ts';

export interface ReceiptRow {
  id: number;
  payment_id: number;
  receipt_number: string;
  lookup_token: string;
  width_mm: number;
  pdf_storage_key: string | null;
  generated_at: string | null;
  generation_attempts: number;
}

export interface ReceiptData {
  widthMm: 80 | 58;
  logoPath: string;
  venueName: string;
  addressLines: string[];
  phone: string;
  taxId: string;
  title: string;
  receiptNumber: string;
  tableNumber: number;
  sessionCode: string;
  billNumber: string;
  orderNumbers: string[];
  paidAt: string;
  cashier: string;
  lines: BillLine[];
  subtotalSatang: number;
  adjustments: Adjustment[];
  totalSatang: number;
  paymentMethod: string;
  paymentStatus: 'PAID';
  lookupToken: string;
  qrContent: string;
  timeZone: string;
}

/** Everything on the receipt comes from the frozen bill and the recorded payment. */
export function loadReceiptData(db: Database, config: Config, receipt: ReceiptRow): ReceiptData {
  const payment = db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', [receipt.payment_id])!;
  const bill = getBill(db, payment.bill_id)!;
  const view = frozenBillView(db, bill);
  const session = getSession(db, bill.session_id)!;
  const table = getTableById(db, session.table_id);
  const cashier = db.get<{ display_name: string }>('SELECT display_name FROM staff WHERE id = ?', [payment.confirmed_by])!;
  return {
    widthMm: receipt.width_mm === 58 ? 58 : 80,
    logoPath: config.receipt.logoPath,
    venueName: config.venue.name,
    addressLines: config.venue.addressLines,
    phone: config.venue.phone,
    taxId: config.venue.taxId,
    title: config.receipt.title,
    receiptNumber: receipt.receipt_number,
    tableNumber: table.display_number,
    sessionCode: session.session_code,
    billNumber: bill.bill_number,
    orderNumbers: view.orderNumbers,
    paidAt: payment.confirmed_at,
    cashier: cashier.display_name,
    lines: view.lines,
    subtotalSatang: view.subtotalSatang,
    adjustments: view.adjustments,
    totalSatang: payment.amount_satang,
    paymentMethod: payment.method,
    paymentStatus: 'PAID',
    lookupToken: receipt.lookup_token,
    qrContent: config.receipt.customerDownload ? `${config.publicBaseUrl}/api/public/receipt/${receipt.lookup_token}` : receipt.lookup_token,
    timeZone: config.displayTimeZone,
  };
}
