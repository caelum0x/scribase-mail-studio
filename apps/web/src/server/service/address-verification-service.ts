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
 * inboxes for real, which "unverified" never did.
 */

export type ReacherVerdict = "safe" | "risky" | "invalid" | "unknown" | "unverified";

export type AddressCheckResult = {
  /** True only when the verdict is in REACHER_BLOCK_VERDICTS (default: "invalid"). */
  blocked: boolean;
  verdict: ReacherVerdict;
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
    return { blocked: blockedVerdicts().has("invalid"), verdict: "invalid" };
  }

  if (isDisposableDomain(domain)) {
    return { blocked: blockedVerdicts().has("risky"), verdict: "risky" };
  }

  const mx = await checkMx(domain, (d) => dnsResolveMx(d));
  if (mx === "mx_lookup_failed") {
    logger.warn({ email, domain }, "[AddressVerification]: lite MX lookup failed, failing open");
    return { blocked: false, verdict: "unknown" };
  }
  if (mx === "no_mx") {
    return { blocked: blockedVerdicts().has("invalid"), verdict: "invalid" };
  }

  return { blocked: blockedVerdicts().has("safe"), verdict: "safe" };
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
      return { blocked: false, verdict: "unknown" };
    }

    const data = (await response.json()) as ReacherCheckEmailResponse;
    const verdict = (data.is_reachable ?? "unknown").toLowerCase() as ReacherVerdict;

    return { blocked: blockedVerdicts().has(verdict), verdict };
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
    return { blocked: false, verdict: "unknown" };
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

    if (!isConfigured()) {
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
      return { blocked: false, verdict: "unverified" };
    }
    const results = await AddressVerificationService.checkAddresses([
      normalized,
    ]);
    return results[normalized] ?? { blocked: false, verdict: "unverified" };
  }
}
