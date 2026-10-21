import { getRedis, redisKey } from "~/server/redis";
import { logger } from "~/server/logger/log";

/**
 * Minimal dependency the limiter needs from a counter store: "how many
 * requests for this key in the current window". Kept this narrow (instead of
 * depending on IORedis directly) so the limiter's actual decision logic is a
 * pure function that unit tests can exercise with an in-memory fake — no
 * Redis required for the test that matters (does the math work).
 */
export interface RateLimitStore {
  increment(key: string, windowSeconds: number): Promise<number>;
}

/** Real, Redis-backed store used in production (fixed window, keyed by caller). */
export class RedisRateLimitStore implements RateLimitStore {
  async increment(key: string, windowSeconds: number): Promise<number> {
    const redis = getRedis();
    const fullKey = redisKey(key);
    const count = await redis.incr(fullKey);
    if (count === 1) {
      await redis.expire(fullKey, windowSeconds);
    }
    return count;
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window limiter: `limit` requests per `windowSeconds` for `key`.
 * Fails open on a store error (same trade-off as `enforceTeamRateLimit` in
 * `~/server/public-api/rate-limit.ts`) — an unavailable Redis must never lock
 * every user out of signing in.
 */
export async function checkRateLimit(
  store: RateLimitStore,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  let count: number;
  try {
    count = await store.increment(key, windowSeconds);
  } catch (err) {
    logger.error({ err, key }, "[Auth]: Rate limit store error, failing open");
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: windowSeconds,
  };
}
