/**
 * MultiRegionService – Resend-style region name mapping and per-domain
 * OCI region / dedicated-IP pool support.
 *
 * Resend exposes four named regions:
 *   us-east-1   → OCI us-ashburn-1
 *   eu-west-1   → OCI eu-frankfurt-1
 *   sa-east-1   → OCI sa-saopaulo-1
 *   ap-northeast-1 → OCI ap-tokyo-1
 *
 * Dedicated IP pools:
 *   OCI supports dedicated IP pools via a support request. We model them as a
 *   team-level `sendingPool` string (admin-only). The SMTP credentials for a
 *   given pool must be provisioned by the infra team and configured via env
 *   vars `OCI_SMTP_POOL_<POOL_NAME>_HOST`, `_USER`, `_PASS`.  When a pool is
 *   set for a team, the email queue service picks up the pool-specific SMTP
 *   config instead of the default.  If no pool-specific config is found we
 *   fall back to the default SMTP credentials and log a warning.
 */

import { logger } from "~/server/logger/log";

// ─── Region mapping ───────────────────────────────────────────────────────────

/**
 * Resend canonical region name → OCI region identifier.
 * Additional OCI regions can be added; they are returned as-is from the
 * `getOciRegion` function (the OCI SDK accepts any valid OCI region string).
 */
export const RESEND_TO_OCI_REGION: Record<string, string> = {
  "us-east-1": "us-ashburn-1",
  "eu-west-1": "eu-frankfurt-1",
  "sa-east-1": "sa-saopaulo-1",
  "ap-northeast-1": "ap-tokyo-1",
};

/**
 * OCI region identifier → Resend canonical region name.
 * Used to present a Resend-compatible region label in the compat API.
 */
export const OCI_TO_RESEND_REGION: Record<string, string> = Object.fromEntries(
  Object.entries(RESEND_TO_OCI_REGION).map(([k, v]) => [v, k]),
);

/**
 * Convert a Resend region name or OCI region name to an OCI region identifier.
 * Falls back to the input value so that valid OCI names pass through unchanged.
 */
export function toOciRegion(region: string): string {
  return RESEND_TO_OCI_REGION[region] ?? region;
}

/**
 * Convert an OCI region to the closest Resend region name.
 * Returns the OCI region unchanged if no mapping exists.
 */
export function toResendRegion(ociRegion: string): string {
  return OCI_TO_RESEND_REGION[ociRegion] ?? ociRegion;
}

/** All Resend-compatible region labels this installation supports. */
export function getSupportedResendRegions(): string[] {
  return Object.keys(RESEND_TO_OCI_REGION);
}

// ─── Dedicated IP pool SMTP lookup ───────────────────────────────────────────

export interface SmtpCredentials {
  host: string;
  port: number;
  user: string;
  pass: string;
  poolName: string | null;
}

/**
 * Returns SMTP credentials for the given pool name.
 * Pool-specific credentials are read from env vars of the form:
 *   OCI_SMTP_POOL_<UPPERCASE_POOL_NAME>_HOST
 *   OCI_SMTP_POOL_<UPPERCASE_POOL_NAME>_PORT  (default: 587)
 *   OCI_SMTP_POOL_<UPPERCASE_POOL_NAME>_USER
 *   OCI_SMTP_POOL_<UPPERCASE_POOL_NAME>_PASS
 *
 * Falls back to the default SMTP credentials when no pool-specific config exists.
 */
export function getSmtpCredentialsForPool(poolName: string | null): SmtpCredentials | null {
  if (poolName) {
    const key = poolName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const host = process.env[`OCI_SMTP_POOL_${key}_HOST`];
    const user = process.env[`OCI_SMTP_POOL_${key}_USER`];
    const pass = process.env[`OCI_SMTP_POOL_${key}_PASS`];
    const port = parseInt(process.env[`OCI_SMTP_POOL_${key}_PORT`] ?? "587", 10);

    if (host && user && pass) {
      return { host, port, user, pass, poolName };
    }

    logger.warn(
      { poolName },
      "[MultiRegionService] Dedicated IP pool SMTP credentials not found; falling back to default",
    );
  }

  // Default credentials from env
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = parseInt(process.env.SMTP_PORT ?? "587", 10);

  if (!host || !user || !pass) return null;

  return { host, port, user, pass, poolName: null };
}
