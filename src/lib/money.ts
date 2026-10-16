/** All money is integer satang (1 THB = 100 satang). */

export function assertSatang(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid satang amount: ${value}`);
  return value;
}

/** "฿1,220" or "฿1,220.50" — for UI and Telegram. */
export function formatBaht(satang: number): string {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  const baht = Math.floor(abs / 100);
  const st = abs % 100;
  const whole = baht.toLocaleString('en-US');
  return `${sign}฿${whole}${st ? '.' + String(st).padStart(2, '0') : ''}`;
}

/** "1,220.00" — for receipts. */
export function formatAmount(satang: number): string {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  return `${sign}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parse "280", "280.5", "280.50" THB into satang. */
export function parseBaht(input: string): number {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) throw new Error(`Invalid THB amount: "${input}"`);
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}

/** Basis-point percentage, rounded half-up to the nearest satang. */
export function applyBps(amountSatang: number, bps: number): number {
  return Math.floor((amountSatang * bps + 5000) / 10000);
}
