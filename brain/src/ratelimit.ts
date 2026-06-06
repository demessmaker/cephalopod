// In-memory token-bucket rate limiter (per key, e.g. per token). Pure and
// deterministic given an injected clock, so it's unit-testable. For the
// single-process self-host brain; a distributed limiter (Redis) is a scale item.
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  /** @param capacity burst size @param refillPerSec sustained rate */
  constructor(private capacity: number, private refillPerSec: number) {}

  /** Consume one token for `key`. Returns false (rate-limited) if none available. */
  allow(key: string, now: number = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, last: now };
    const elapsed = Math.max(0, (now - b.last) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.last = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }
}
