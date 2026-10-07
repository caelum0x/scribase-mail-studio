import type { Context } from "hono";
import { getRedis, redisKey } from "~/server/redis";
import { logger } from "../logger/log";
import { UnsendApiError } from "./api-error";

/** Resend's default is 10 requests per second per team. */
export const DEFAULT_API_RATE_LIMIT = 10;
export const RATE_LIMIT_WINDOW_SECONDS = 1;

type RateLimitedTeam = { id: number; apiRateLimit?: number | null };

/**
 * Fixed-window per-team limiter shared by the native and Resend-compatible
 * APIs (one budget per team across both). Sets X-RateLimit-* plus the
 * IETF/Resend `ratelimit-*` headers and throws RATE_LIMITED when exceeded.
 * Fails open if Redis is unavailable.
 */
export async function enforceTeamRateLimit(
  c: Context,
  team: RateLimitedTeam,
): Promise<void> {
  const limit = team.apiRateLimit ?? DEFAULT_API_RATE_LIMIT;
  const key = redisKey(`rl:${team.id}`);
  const redis = getRedis();

  let currentRequests: number;
  let ttl: number;

  try {
    currentRequests = await redis.incr(key);
    if (currentRequests === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    }
    ttl = await redis.ttl(key);
  } catch (error) {
    logger.error({ err: error }, "Redis error during rate limiting");
    return;
  }

  const windowLeft = ttl > 0 ? ttl : RATE_LIMIT_WINDOW_SECONDS;
  const resetTime = Math.floor(Date.now() / 1000) + windowLeft;
  const remainingRequests = Math.max(0, limit - currentRequests);

  c.res.headers.set("X-RateLimit-Limit", String(limit));
  c.res.headers.set("X-RateLimit-Remaining", String(remainingRequests));
  c.res.headers.set("X-RateLimit-Reset", String(resetTime));
  c.res.headers.set("ratelimit-limit", String(limit));
  c.res.headers.set("ratelimit-remaining", String(remainingRequests));
  c.res.headers.set("ratelimit-reset", String(windowLeft));

  if (currentRequests > limit) {
    c.res.headers.set("Retry-After", String(windowLeft));
    throw new UnsendApiError({
      code: "RATE_LIMITED",
      message: `Rate limit exceeded. Try again in ${windowLeft} seconds.`,
    });
  }
}
