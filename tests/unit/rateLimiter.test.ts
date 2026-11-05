import { describe, expect, it } from 'vitest';
import { SlidingWindowRateLimiter } from '../../src/utils/rateLimiter.js';

describe('SlidingWindowRateLimiter', () => {
  it('allows the configured number of calls per window and rejects the next one', () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 10_000 });

    expect(limiter.consume('user-1', 0).allowed).toBe(true);
    expect(limiter.consume('user-1', 0).allowed).toBe(true);
    expect(limiter.consume('user-1', 0).allowed).toBe(true);
    expect(limiter.consume('user-1', 0)).toEqual({ allowed: false, retryAfterMs: 10_000 });
  });

  it('reports how long until the oldest call leaves the window', () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 10_000 });
    limiter.consume('user-1', 0);
    limiter.consume('user-1', 0);
    limiter.consume('user-1', 0);

    expect(limiter.consume('user-1', 4_000)).toEqual({ allowed: false, retryAfterMs: 6_000 });
  });

  it('allows a new call once the oldest call has left the window', () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 10_000 });
    limiter.consume('user-1', 0);
    limiter.consume('user-1', 0);
    limiter.consume('user-1', 0);

    expect(limiter.consume('user-1', 10_000).allowed).toBe(true);
  });

  it('does not count rejected calls against the window', () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1_000 });
    limiter.consume('user-1', 0);
    for (const now of [500, 500, 500, 500, 500]) {
      limiter.consume('user-1', now);
    }

    expect(limiter.consume('user-1', 1_000).allowed).toBe(true);
  });

  it('tracks each key independently', () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1_000 });
    limiter.consume('user-1', 0);

    expect(limiter.consume('user-1', 0).allowed).toBe(false);
    expect(limiter.consume('user-2', 0).allowed).toBe(true);
  });
});
