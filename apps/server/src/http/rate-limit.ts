/**
 * Fixed-window rate limiting kept in memory. Good for a single node; for
 * several API nodes put a shared limiter (or the load balancer's) in front.
 */
export interface RateRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, rule: RateRule): RateDecision {
    const now = this.now();
    this.sweep(now);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + rule.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= rule.limit;
    return {
      allowed,
      remaining: Math.max(0, rule.limit - bucket.count),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  /** Forget a key, e.g. after a successful login. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}

export const RATE_RULES = {
  /** Sign-in attempts per IP and address. */
  login: { limit: 10, windowMs: 15 * 60_000 },
  /** Account creation and invitation acceptance per IP. */
  signup: { limit: 10, windowMs: 60 * 60_000 },
  /** Authenticated API calls per principal. */
  api: { limit: 1200, windowMs: 60_000 },
  /** Expensive calls (AI, test sends, exports) per principal. */
  expensive: { limit: 30, windowMs: 60_000 },
  /** Public recipient endpoints per IP (tracking, unsubscribe). */
  public: { limit: 300, windowMs: 60_000 },
  /** Provider webhooks per integration. */
  webhook: { limit: 3000, windowMs: 60_000 },
} satisfies Record<string, RateRule>;
