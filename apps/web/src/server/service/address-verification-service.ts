import { env } from "~/env";
import { logger } from "~/server/logger/log";

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
      const result: Record<string, AddressCheckResult> = {};
      uniqueEmails.forEach((email) => {
        result[email] = { blocked: false, verdict: "unverified" };
      });
      return result;
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
