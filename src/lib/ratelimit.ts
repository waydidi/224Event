/** Fixed-window in-memory rate limiter. Suitable for a single-instance deployment. */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Returns true if allowed, false if the limit for this key is exhausted. */
  hit(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    if (t - this.lastSweep > 60_000) this.sweep(t);
    const w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      this.windows.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    w.count++;
    return w.count <= limit;
  }

  private sweep(t: number) {
    this.lastSweep = t;
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
  }
}
