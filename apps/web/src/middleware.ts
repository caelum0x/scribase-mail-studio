import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  checkRateLimit,
  RedisRateLimitStore,
} from "~/server/auth/auth-rate-limit";

/**
 * Defense-in-depth for the passwordless email sign-in flow. The sign-in
 * token itself is already a CSPRNG value with a short expiry (see
 * `~/server/auth.ts`'s `generateSignInToken`/`SIGN_IN_TOKEN_MAX_AGE`), which
 * already makes brute-forcing it impractical — but that app had, until this
 * change, zero rate limiting on either endpoint: an attacker could still
 * flood `/api/auth/signin/email` to spam a victim's inbox with sign-in
 * emails, or hammer `/api/auth/callback/email` with guesses. Per-IP, fixed
 * window, fails open on a Redis outage (same trade-off as the existing
 * per-team API limiter in `~/server/public-api/rate-limit.ts`).
 */
const WINDOW_SECONDS = 10 * 60;
const SIGNIN_REQUEST_LIMIT = 5;
const CALLBACK_ATTEMPT_LIMIT = 20;

const store = new RedisRateLimitStore();

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function middleware(req: NextRequest) {
  const isCallback = req.nextUrl.pathname === "/api/auth/callback/email";
  const limit = isCallback ? CALLBACK_ATTEMPT_LIMIT : SIGNIN_REQUEST_LIMIT;
  const routeKey = isCallback ? "callback" : "signin";
  const key = `authrl:${routeKey}:${clientIp(req)}`;

  const result = await checkRateLimit(store, key, limit, WINDOW_SECONDS);
  if (!result.allowed) {
    return new NextResponse("Too many attempts. Try again later.", {
      status: 429,
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/auth/callback/email", "/api/auth/signin/email"],
};

// IORedis needs the Node.js runtime (not Edge) to open a real TCP connection.
export const runtime = "nodejs";
