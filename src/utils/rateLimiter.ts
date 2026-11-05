export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Milliseconds until the next call would be allowed; zero when allowed. */
  readonly retryAfterMs: number;
}

export interface SlidingWindowOptions {
  /** Maximum number of allowed calls inside one window. Must be at least 1. */
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Counts allowed calls per key inside a sliding time window. Rejected calls are
 * not recorded, so a user who keeps retrying regains access as soon as the
 * window clears. The clock is injectable so tests can control time.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly options: SlidingWindowOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError('Rate limit must allow at least one call');
    }
  }

  consume(key: string, now: number = Date.now()): RateLimitDecision {
    const { limit, windowMs } = this.options;
    const recent = (this.hits.get(key) ?? []).filter((time) => now - time < windowMs);

    if (recent.length >= limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterMs: oldest + windowMs - now };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}
