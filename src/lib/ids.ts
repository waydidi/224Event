import crypto from 'node:crypto';

/** URL-safe, non-guessable random token. */
export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Numeric PIN of the given length using a CSPRNG (no modulo bias). */
export function randomPin(length = 6): string {
  let pin = '';
  for (let i = 0; i < length; i++) pin += String(crypto.randomInt(0, 10));
  return pin;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function padNumber(prefix: string, n: number, width: number): string {
  return `${prefix}${String(n).padStart(width, '0')}`;
}
