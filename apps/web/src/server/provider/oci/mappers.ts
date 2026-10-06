import { DomainStatus } from "@prisma/client";
import type { ProviderSuppressionReason } from "../types";

export const OCI_SPF_RECORD = "v=spf1 include:rp.oracleemaildelivery.com ~all";

/**
 * OCI DKIM lifecycle: CREATING -> NEEDS_ATTENTION (CNAME not found yet)
 * -> ACTIVE (CNAME verified, signing enabled).
 */
export function mapDkimLifecycleState(state: string | undefined | null) {
  switch (state) {
    case "ACTIVE":
      return DomainStatus.SUCCESS;
    case "CREATING":
    case "UPDATING":
    case "NEEDS_ATTENTION":
      return DomainStatus.PENDING;
    case "INACTIVE":
      return DomainStatus.TEMPORARY_FAILURE;
    case "FAILED":
    case "DELETING":
    case "DELETED":
      return DomainStatus.FAILED;
    default:
      return DomainStatus.NOT_STARTED;
  }
}

export function mapSuppressionReason(
  reason: string | undefined | null,
): ProviderSuppressionReason {
  switch (reason) {
    case "HARDBOUNCE":
      return "HARD_BOUNCE";
    case "SOFTBOUNCE":
      return "SOFT_BOUNCE";
    case "COMPLAINT":
      return "COMPLAINT";
    case "MANUAL":
      return "MANUAL";
    case "UNSUBSCRIBE":
      return "UNSUBSCRIBE";
    default:
      return "UNKNOWN";
  }
}

/** Extracts and normalizes the address from `Name <user@example.com>`. */
export function extractEmailAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  const address = (match?.[1] ?? value).trim().toLowerCase();
  return address;
}

export function stripAngleBrackets(value: string) {
  return value.trim().replace(/^</, "").replace(/>$/, "");
}

export function dkimRecordName(selector: string, domain: string) {
  return `${selector}._domainkey.${domain}`;
}

/**
 * OCI DKIM names must be unique per domain and are used as the selector.
 * Format: `<prefix>-<region-code>-<yyyymmdd>` (lowercase, <= 63 chars).
 */
export function buildDkimSelector(
  prefix: string,
  region: string,
  now: Date = new Date(),
) {
  const regionCode = region.split("-")[1]?.slice(0, 4) ?? "oci";
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${regionCode}-${date}`.toLowerCase().slice(0, 63);
}
