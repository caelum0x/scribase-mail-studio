import { TRPCError } from "@trpc/server";
import { getRedis, redisKey } from "~/server/redis";

// A 6-digit code is brute-forceable without a cap: 5 failures lock the
// second factor for 15 minutes.
export const MFA_MAX_FAILURES = 5;
export const MFA_LOCK_SECONDS = 15 * 60;

const failureKey = (userId: number) => redisKey(`mfa:failures:${userId}`);

/** Runs `verify`, counting failures per user and refusing once locked. */
export async function withMfaAttemptGuard(
  userId: number,
  verify: () => Promise<boolean>,
): Promise<boolean> {
  const redis = getRedis();
  const key = failureKey(userId);
  const failures = Number((await redis.get(key)) ?? 0);
  if (failures >= MFA_MAX_FAILURES) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many invalid codes. Try again in 15 minutes.",
    });
  }

  const valid = await verify();
  if (valid) {
    await redis.del(key);
  } else {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, MFA_LOCK_SECONDS);
  }
  return valid;
}
