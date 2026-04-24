/**
 * In-memory rate limiter (task 14.13).
 *
 * MVP-grade fixed-window counter — `Map<key, {tokens, resetAt}>` —
 * sufficient to cap abuse on a single API instance. The plan calls
 * this a "token bucket" but the actual semantics are simpler: each
 * key starts with `limit` tokens at the start of a `windowMs` window,
 * tokens are decremented per request, and the window resets when
 * `resetAt` is in the past. This avoids the bookkeeping of a true
 * leaky bucket while still bounding requests-per-window cleanly.
 *
 * Two budgets are wired up in `app.ts`:
 *   - POST /api/agents : 10 / hour per Privy DID (auth middleware
 *     already populates `c.get('userId')`)
 *   - POST /v1/traces  : 100 / minute per agent.token (extracted from
 *     the OTLP envelope, so the limiter is invoked from inside the
 *     route handler after auth resolves)
 *
 * Single-instance assumption: if the API is ever scaled horizontally,
 * each pod has its own counters → effective limit is `pods × limit`.
 * Acceptable today (Railway ships one container); switch to Redis
 * with INCR + EXPIRE when scaling out.
 */

import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ApiEnv } from './auth';

interface BucketState {
  tokens: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Tokens granted per window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Max distinct keys held in memory. Oldest evicted first. Default 10k. */
  maxKeys?: number;
}

export interface RateLimitDecision {
  /** True when the request is allowed and a token was deducted. */
  ok: boolean;
  /** Tokens remaining in the current window after this call. */
  remaining: number;
  /** Seconds the caller should wait before retrying. 0 when ok. */
  retryAfterSec: number;
}

export interface RateLimiter {
  take(key: string): RateLimitDecision;
}

/**
 * Always-allow limiter. Useful as a default in places that want to wire
 * a `RateLimiter` unconditionally (so types stay simple) but where the
 * caller hasn't opted in. Tests get this for free.
 */
export const NOOP_RATE_LIMITER: RateLimiter = {
  take: () => ({ ok: true, remaining: Number.POSITIVE_INFINITY, retryAfterSec: 0 }),
};

/**
 * Build a fresh limiter. Counters are private to the returned closure
 * so different routes can share a single module without cross-talk.
 */
export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const { limit, windowMs } = opts;
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map<string, BucketState>();

  function evictIfNeeded(): void {
    // Map iteration is insertion order, so .keys().next() is the oldest.
    while (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  return {
    take(key: string): RateLimitDecision {
      const now = Date.now();
      let bucket = buckets.get(key);

      if (!bucket || bucket.resetAt <= now) {
        evictIfNeeded();
        bucket = { tokens: limit, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }

      if (bucket.tokens <= 0) {
        return {
          ok: false,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        };
      }

      bucket.tokens -= 1;
      return { ok: true, remaining: bucket.tokens, retryAfterSec: 0 };
    },
  };
}

/**
 * Hono middleware factory. Pulls a key out of the request context;
 * `null` means "skip the limiter" (e.g. unauthenticated request that
 * earlier middleware will reject anyway). On a miss, sets
 * `Retry-After` and `X-RateLimit-*` headers and throws 429.
 */
export function rateLimitMiddleware(
  limiter: RateLimiter,
  getKey: (c: Parameters<MiddlewareHandler<ApiEnv>>[0]) => string | null,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const key = getKey(c);
    if (!key) {
      await next();
      return;
    }
    const decision = limiter.take(key);
    if (!decision.ok) {
      c.header('Retry-After', String(decision.retryAfterSec));
      c.header('X-RateLimit-Remaining', '0');
      throw new HTTPException(429, { message: 'rate limit exceeded' });
    }
    c.header('X-RateLimit-Remaining', String(decision.remaining));
    await next();
  };
}
