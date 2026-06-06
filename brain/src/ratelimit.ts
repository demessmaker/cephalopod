// In-memory token-bucket rate limiter (per key, e.g. per token). Pure and
// deterministic given an injected clock, so it's unit-testable. For the
// single-process self-host brain; a distributed limiter (Redis) is a scale item.
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  /** @param capacity burst size @param refillPerSec sustained rate */
  constructor(private capacity: number, private refillPerSec: number) {}

  /** Consume one token for `key`. Returns false (rate-limited) if none available. */
  allow(key: string, now: number = Date.now()): boolean {
    const had = this.buckets.get(key);
    const b = had ?? { tokens: this.capacity, last: now };
    const elapsed = Math.max(0, (now - b.last) / 1000);
    const refilled = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.tokens = refilled;
    b.last = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    // Drop a previously-seen key once it has been idle long enough to fully refill:
    // it's then indistinguishable from a fresh key, so retaining it only leaks
    // memory. This bounds the map to keys active within the refill window. (A brand
    // new key starts full, so only `had` keys are eligible — never drop on creation.)
    if (had && refilled >= this.capacity) this.buckets.delete(key);
    else this.buckets.set(key, b);
    return ok;
  }

  /** Number of live buckets (active keys). Exposed for tests/observability. */
  get size(): number {
    return this.buckets.size;
  }
}
