import { resolveMx as dnsResolveMx } from "node:dns/promises";

import { env } from "~/env";
import { logger } from "~/server/logger/log";
import {
  checkMx,
  isDisposableDomain,
  normalizeEmailDomain,
} from "~/server/service/signup-screening";

/**
 * Pre-send address verification against a self-hosted
 * reacherhq/check-if-email-exists backend (REST API, `reacherhq/backend`
 * Docker image: https://github.com/reacherhq/check-if-email-exists).
 *
 * Zero infra cost (self-hosted, no SaaS fee), cuts bounce rate by catching
 * undeliverable addresses before a send ever reaches the provider (and
 * before it counts against the team's send credits/limit).
 *
 * Fail-open by design: if the verifier is disabled, unconfigured,
 * unreachable, slow, or returns a bad response, every address is treated as
 * "unverified" (not blocked). A down validator must never silently drop a
 * legitimate send.
 *
 * Real deployment constraint: this box's outbound TCP 25 is blocked (Oracle
 * Cloud default), so a self-hosted Reacher backend can never complete its
 * SMTP handshake check here — `isConfigured()` being true doesn't mean the
 * verdict is trustworthy. When Reacher isn't actually configured/usable, a
 * "lite" fallback (syntax + MX record + disposable-domain check, reusing the
 * exact same screening primitives already battle-tested for signup
 * screening) runs instead of silently verifying nothing. It can't catch a
 * dead mailbox on an otherwise-healthy domain the way a real SMTP check can
 * — but it does catch bad syntax, non-existent domains, and disposable
 * inboxes for real, which "unverified" never did. `AddressCheckResult.method`
 * tells callers which path produced the verdict ("reacher_smtp" vs
 * "lite_fallback"), so a degraded-confidence "safe" is never indistinguishable
 * from a real SMTP-confirmed one.
 *
 * Self-test / auto-demote guard: `isConfigured()` only proves the env vars
 * are *set* — it can't prove Reacher can actually finish an SMTP check (e.g.
 * if outbound TCP 25 is blocked at the network level, Reacher's backend
 * returns a normal 200 with `is_reachable: "unknown"` for every address,
 * forever, while this module would otherwise happily label that
 * `method: "reacher_smtp"` as if it were authoritative). Before trusting a
 * configured Reacher, `ensureReacherHealthy()` runs a real, cached probe
 * (`REACHER_SELFTEST_EMAIL`, a made-up mailbox at a real non-catch-all
 * provider) and only treats Reacher as healthy if that probe comes back with
 * a determinate verdict (not "unknown"). If the probe fails, every check
 * silently-but-visibly (a clear logged warning, not a silent downgrade)
 * demotes to the same `liteCheck()` fallback used when Reacher isn't
 * configured at all, until a later re-probe (after `REACHER_SELFTEST_TTL_MS`)
 * finds it healthy again.
 */

export type ReacherVerdict = "safe" | "risky" | "invalid" | "unknown" | "unverified";

/**
 * How a verdict was produced. Callers that need to tell a real,
 * SMTP-mailbox-confirmed "safe" apart from a degraded, domain-only "safe"
 * (syntax + MX + disposable checks only, e.g. because outbound TCP 25 is
 * blocked on this host) should key off this instead of `verdict` alone —
 * `verdict` keeps its existing meaning/values for backward compatibility
 * with `REACHER_BLOCK_VERDICTS` and existing callers.
 */
export type AddressCheckMethod = "reacher_smtp" | "lite_fallback" | "none";

export type AddressCheckResult = {
  /** True only when the verdict is in REACHER_BLOCK_VERDICTS (default: "invalid"). */
  blocked: boolean;
  verdict: ReacherVerdict;
  /**
   * "reacher_smtp": a real SMTP-probe verdict from the configured Reacher
   * backend. "lite_fallback": Reacher wasn't configured/usable, so this
   * verdict only reflects syntax + MX + disposable-domain checks — it can
   * rule out a dead domain or bad syntax, but it does NOT confirm the
   * mailbox itself exists. A "safe" lite_fallback result is honestly
   * "no red flags found", not "verified deliverable".
   */
  method: AddressCheckMethod;
};

type ReacherCheckEmailResponse = {
  is_reachable?: string;
};

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function blockedVerdicts(): Set<string> {
  return new Set(
    env.REACHER_BLOCK_VERDICTS.split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isConfigured(): boolean {
  return env.REACHER_ENABLED && Boolean(env.REACHER_API_URL);
}

/** Re-probe at most this often; recovery/regression is picked up within one TTL window. */
const REACHER_SELFTEST_TTL_MS = 10 * 60 * 1000;

type ReacherHealthState = { healthy: boolean; checkedAt: number };

let reacherHealthCache: ReacherHealthState | null = null;

/**
 * Test-only: directly sets (or clears, with `null`) the cached self-test
 * result. Lets tests either force a clean slate (so the next call runs a
 * real probe) or pre-warm a known health state without spending the test's
 * `fetch` mock on an extra probe call.
 */
export function _setReacherHealthCacheForTests(state: ReacherHealthState | null): void {
  reacherHealthCache = state;
}

/**
 * Confirms Reacher can actually complete an SMTP check, not just that its
 * HTTP endpoint is reachable. Probes a made-up mailbox at a real,
 * non-catch-all provider (`REACHER_SELFTEST_EMAIL`, default gmail.com): that
 * provider's SMTP server genuinely validates RCPT TO per-mailbox, so a
 * healthy Reacher backend MUST come back with a determinate verdict
 * ("invalid" in the normal case — the probe mailbox doesn't exist). A
 * structurally broken Reacher (e.g. outbound TCP 25 blocked) can never
 * finish that handshake and comes back "unknown" instead — the same signal
 * documented in production for this exact failure mode.
 */
async function probeReacherOnce(): Promise<boolean> {
  const probe = await checkOne(env.REACHER_SELFTEST_EMAIL);
  return probe.verdict !== "unknown";
}

/**
 * Cached, periodically-refreshed self-test gate. Returns false (demote to
 * `liteCheck()`) whenever Reacher is configured but can't prove it can
 * finish a real SMTP check — logging a clear warning so the downgrade is
 * never silent. Returns true (and logs a recovery notice) once a later probe
 * succeeds again.
 */
async function ensureReacherHealthy(): Promise<boolean> {
  const now = Date.now();
  if (reacherHealthCache && now - reacherHealthCache.checkedAt < REACHER_SELFTEST_TTL_MS) {
    return reacherHealthCache.healthy;
  }

  const wasHealthy = reacherHealthCache?.healthy;
  const healthy = await probeReacherOnce();
  reacherHealthCache = { healthy, checkedAt: now };

  if (!healthy) {
    logger.warn(
      { reacherApiUrl: env.REACHER_API_URL, selftestEmail: env.REACHER_SELFTEST_EMAIL },
      "[AddressVerification]: Reacher self-test failed (SMTP check never completed — e.g. outbound TCP 25 blocked); auto-demoting every address check to the lite fallback (syntax+MX+disposable) until Reacher recovers",
    );
  } else if (wasHealthy === false) {
    logger.info(
      { reacherApiUrl: env.REACHER_API_URL },
      "[AddressVerification]: Reacher self-test recovered; resuming real SMTP-backed checks",
    );
  }

  return healthy;
}

/**
 * Lite verification: syntax + MX record + disposable-domain check, no SMTP
 * handshake required. Used as the default fallback when the Reacher SMTP
 * backend isn't configured (or configured but non-functional, e.g. outbound
 * TCP 25 blocked) — a real check instead of blind "unverified".
 *
 * Maps onto the same `ReacherVerdict` space so callers (and
 * `REACHER_BLOCK_VERDICTS`) don't need to special-case the fallback path:
 *  - invalid syntax or no usable MX record  -> "invalid" (genuinely can't receive mail)
 *  - disposable domain                      -> "risky" (can receive mail, low-quality signup)
 *  - MX lookup failed (network blip)        -> "unknown" (fail open, not the address's fault)
 *  - syntax + MX both check out             -> "safe" (domain-level only; can't prove the mailbox itself exists)
 */
async function liteCheck(email: string): Promise<AddressCheckResult> {
  const domain = normalizeEmailDomain(email);
  if (!domain) {
    return { blocked: blockedVerdicts().has("invalid"), verdict: "invalid", method: "lite_fallback" };
  }

  if (isDisposableDomain(domain)) {
    return { blocked: blockedVerdicts().has("risky"), verdict: "risky", method: "lite_fallback" };
  }

  const mx = await checkMx(domain, (d) => dnsResolveMx(d));
  if (mx === "mx_lookup_failed") {
    logger.warn({ email, domain }, "[AddressVerification]: lite MX lookup failed, failing open");
    return { blocked: false, verdict: "unknown", method: "lite_fallback" };
  }
  if (mx === "no_mx") {
    return { blocked: blockedVerdicts().has("invalid"), verdict: "invalid", method: "lite_fallback" };
  }

  return { blocked: blockedVerdicts().has("safe"), verdict: "safe", method: "lite_fallback" };
}

async function checkOne(email: string): Promise<AddressCheckResult> {
  const apiUrl = env.REACHER_API_URL as string;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.REACHER_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (env.REACHER_API_KEY) {
      headers.Authorization = `Bearer ${env.REACHER_API_KEY}`;
    }

    const response = await fetch(
      `${apiUrl.replace(/\/+$/, "")}/v0/check_email`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ to_email: email }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      logger.warn(
        { email, status: response.status },
        "[AddressVerification]: reacher returned a non-2xx response, failing open",
      );
      return { blocked: false, verdict: "unknown", method: "reacher_smtp" };
    }

    const data = (await response.json()) as ReacherCheckEmailResponse;
    const verdict = (data.is_reachable ?? "unknown").toLowerCase() as ReacherVerdict;

    return { blocked: blockedVerdicts().has(verdict), verdict, method: "reacher_smtp" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      logger.warn(
        { email, timeoutMs: env.REACHER_TIMEOUT_MS },
        "[AddressVerification]: reacher timed out, failing open (send proceeds)",
      );
    } else {
      logger.warn(
        {
          email,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "[AddressVerification]: reacher unreachable, failing open (send proceeds)",
      );
    }
    return { blocked: false, verdict: "unknown", method: "reacher_smtp" };
  } finally {
    clearTimeout(timeout);
  }
}

export class AddressVerificationService {
  /**
   * Checks a batch of email addresses against the reacher backend.
   * Always resolves (never throws) — every address not confirmed deliverable
   * comes back "unverified"/"unknown" rather than blocked.
   */
  static async checkAddresses(
    emails: string[],
  ): Promise<Record<string, AddressCheckResult>> {
    const uniqueEmails = Array.from(
      new Set(emails.map(normalizeEmail).filter(Boolean)),
    );

    if (uniqueEmails.length === 0) {
      return {};
    }

    if (!isConfigured() || !(await ensureReacherHealthy())) {
      const entries = await Promise.all(
        uniqueEmails.map(async (email) => [email, await liteCheck(email)] as const),
      );
      return Object.fromEntries(entries);
    }

    const entries = await Promise.all(
      uniqueEmails.map(
        async (email) => [email, await checkOne(email)] as const,
      ),
    );

    return Object.fromEntries(entries);
  }

  /** Convenience helper for a single address. */
  static async checkAddress(email: string): Promise<AddressCheckResult> {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      return { blocked: false, verdict: "unverified", method: "none" };
    }
    const results = await AddressVerificationService.checkAddresses([
      normalized,
    ]);
    return results[normalized] ?? { blocked: false, verdict: "unverified", method: "none" };
  }
}
