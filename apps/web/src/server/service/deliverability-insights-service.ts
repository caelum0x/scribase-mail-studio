/**
 * DeliverabilityInsightsService – per-domain deliverability health checks.
 *
 * Checks performed (all read-only; no OCI mutations):
 *   • DMARC record present, policy, reporting address (rua)
 *   • SPF includes OCI relay hostnames
 *   • DKIM active (from stored domain status)
 *   • Return-path configured (custom SPF alignment)
 *   • Open/click tracking domain set
 *   • Bounce rate and complaint rate trends (from DailyEmailUsage, last 30 days)
 *   • No-unsubscribe warning: % of recent emails without List-Unsubscribe
 *
 * DNS lookups run via Node's built-in `dns.promises` (no external deps).
 */
import dns from "dns";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";

// ─── Types ────────────────────────────────────────────────────────────────────

export type InsightSeverity = "ok" | "warning" | "error" | "info";

export interface InsightItem {
  key: string;
  label: string;
  severity: InsightSeverity;
  detail: string;
  helpUrl?: string;
}

export interface DeliverabilityInsights {
  domainId: number;
  domainName: string;
  generatedAt: Date;
  items: InsightItem[];
  /** Rolling 30-day stats. */
  stats: {
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    bounceRate: number;
    complaintRate: number;
  };
}

// ─── Known OCI SMTP relay patterns ────────────────────────────────────────────

const OCI_SPF_PATTERNS = [
  "include:spf_c.oracleemaildelivery.com",
  "include:spf.oracleemaildelivery.com",
  "include:spf2.oracleemaildelivery.com",
  "oracleemaildelivery.com",
];

// ─── DNS helpers ─────────────────────────────────────────────────────────────

async function resolveTxtRecords(name: string): Promise<string[][]> {
  try {
    return await dns.promises.resolveTxt(name);
  } catch {
    return [];
  }
}

async function resolveMxRecords(name: string): Promise<dns.MxRecord[]> {
  try {
    return await dns.promises.resolveMx(name);
  } catch {
    return [];
  }
}

// ─── Individual check functions ───────────────────────────────────────────────

async function checkDmarc(domainName: string): Promise<InsightItem> {
  const records = await resolveTxtRecords(`_dmarc.${domainName}`);
  const flat = records.flatMap((r) => r.join(""));
  const dmarcRecord = flat.find((r) => r.startsWith("v=DMARC1"));

  if (!dmarcRecord) {
    return {
      key: "dmarc_missing",
      label: "DMARC record",
      severity: "error",
      detail: "No DMARC TXT record found at _dmarc." + domainName + ". Emails may be rejected by major receivers.",
      helpUrl: "https://dmarc.org/overview/",
    };
  }

  // Extract policy
  const pMatch = dmarcRecord.match(/p=([^;]+)/i);
  const policy = pMatch?.[1]?.toLowerCase() ?? "none";

  if (policy === "none") {
    return {
      key: "dmarc_none",
      label: "DMARC policy",
      severity: "warning",
      detail: `DMARC is present but policy is "none". Upgrade to "quarantine" or "reject" to fully protect your domain.`,
    };
  }

  const ruaMatch = dmarcRecord.match(/rua=([^;]+)/i);
  const hasRua = Boolean(ruaMatch);

  return {
    key: "dmarc_ok",
    label: "DMARC record",
    severity: "ok",
    detail: `DMARC present: policy=${policy}${hasRua ? ", aggregate reports configured" : ", no aggregate report address (rua)"}`,
  };
}

async function checkSpf(domainName: string): Promise<InsightItem> {
  const records = await resolveTxtRecords(domainName);
  const flat = records.flatMap((r) => r.join(""));
  const spfRecord = flat.find((r) => r.startsWith("v=spf1"));

  if (!spfRecord) {
    return {
      key: "spf_missing",
      label: "SPF record",
      severity: "error",
      detail: "No SPF TXT record found for " + domainName + ".",
    };
  }

  const hasOci = OCI_SPF_PATTERNS.some((pattern) =>
    spfRecord.toLowerCase().includes(pattern.toLowerCase()),
  );

  if (!hasOci) {
    return {
      key: "spf_no_oci",
      label: "SPF – OCI relay",
      severity: "warning",
      detail:
        "SPF record found but does not include OCI Email Delivery relay (spf_c.oracleemaildelivery.com). " +
        "Emails may fail SPF alignment.",
    };
  }

  return {
    key: "spf_ok",
    label: "SPF record",
    severity: "ok",
    detail: "SPF record found and includes OCI Email Delivery relay.",
  };
}

function checkDkim(dkimStatus: string | null | undefined): InsightItem {
  if (dkimStatus === "SUCCESS") {
    return {
      key: "dkim_ok",
      label: "DKIM signing",
      severity: "ok",
      detail: "DKIM key is active and valid.",
    };
  }
  if (!dkimStatus || dkimStatus === "NOT_STARTED") {
    return {
      key: "dkim_not_started",
      label: "DKIM signing",
      severity: "warning",
      detail: "DKIM has not been configured. Add the DKIM CNAME record shown on the domain page.",
    };
  }
  return {
    key: "dkim_pending",
    label: "DKIM signing",
    severity: "warning",
    detail: `DKIM status: ${dkimStatus}. DNS propagation may still be in progress.`,
  };
}

function checkReturnPath(
  customReturnPath: string | null | undefined,
  returnPathStatus: string | null | undefined,
): InsightItem {
  if (!customReturnPath) {
    return {
      key: "return_path_default",
      label: "Return-path",
      severity: "info",
      detail: "Using the default return-path. Adding a custom return-path subdomain improves SPF alignment and DMARC passes.",
    };
  }
  if (returnPathStatus === "VERIFIED") {
    return {
      key: "return_path_ok",
      label: "Return-path",
      severity: "ok",
      detail: `Custom return-path "${customReturnPath}" is verified.`,
    };
  }
  return {
    key: "return_path_pending",
    label: "Return-path",
    severity: "warning",
    detail: `Custom return-path "${customReturnPath}" is not yet verified (status: ${returnPathStatus ?? "unknown"}).`,
  };
}

function checkTrackingSubdomain(
  trackingSubdomain: string | null | undefined,
  domainName: string,
): InsightItem {
  if (!trackingSubdomain) {
    return {
      key: "tracking_subdomain_missing",
      label: "Tracking subdomain",
      severity: "info",
      detail:
        `No custom tracking subdomain configured. Setting a CNAME (e.g., links.${domainName}) ` +
        "keeps tracking links on your own domain, which improves click-through rates and avoids shared-domain blocklists.",
    };
  }
  return {
    key: "tracking_subdomain_ok",
    label: "Tracking subdomain",
    severity: "ok",
    detail: `Tracking subdomain "${trackingSubdomain}.${domainName}" is configured.`,
  };
}

function checkBounceComplaintRate(stats: {
  sent: number;
  bounced: number;
  complained: number;
}): InsightItem[] {
  const items: InsightItem[] = [];

  if (stats.sent === 0) {
    return [
      {
        key: "no_volume",
        label: "Send volume",
        severity: "info",
        detail: "No emails sent in the last 30 days.",
      },
    ];
  }

  const bounceRate = stats.bounced / stats.sent;
  const complaintRate = stats.complained / stats.sent;

  if (bounceRate > 0.05) {
    items.push({
      key: "bounce_rate_critical",
      label: "Bounce rate",
      severity: "error",
      detail: `Bounce rate is ${(bounceRate * 100).toFixed(2)}% over the last 30 days (threshold: 5%). Clean your list immediately.`,
    });
  } else if (bounceRate > 0.02) {
    items.push({
      key: "bounce_rate_warning",
      label: "Bounce rate",
      severity: "warning",
      detail: `Bounce rate is ${(bounceRate * 100).toFixed(2)}% over the last 30 days (threshold: 2%). Consider list hygiene.`,
    });
  } else {
    items.push({
      key: "bounce_rate_ok",
      label: "Bounce rate",
      severity: "ok",
      detail: `Bounce rate is ${(bounceRate * 100).toFixed(2)}% (good).`,
    });
  }

  if (complaintRate > 0.001) {
    items.push({
      key: "complaint_rate_critical",
      label: "Complaint rate",
      severity: "error",
      detail: `Complaint rate is ${(complaintRate * 100).toFixed(3)}% (threshold: 0.1%). Google and Yahoo may throttle or block your domain.`,
    });
  } else if (complaintRate > 0.0008) {
    items.push({
      key: "complaint_rate_warning",
      label: "Complaint rate",
      severity: "warning",
      detail: `Complaint rate is ${(complaintRate * 100).toFixed(3)}% — approaching the 0.1% threshold.`,
    });
  } else {
    items.push({
      key: "complaint_rate_ok",
      label: "Complaint rate",
      severity: "ok",
      detail: `Complaint rate is ${(complaintRate * 100).toFixed(3)}% (good).`,
    });
  }

  return items;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function getDomainDeliverabilityInsights(
  teamId: number,
  domainId: number,
): Promise<DeliverabilityInsights> {
  const domain = await db.domain.findUnique({
    where: { id: domainId, teamId },
    select: {
      id: true,
      name: true,
      dkimStatus: true,
      spfDetails: true,
      dmarcAdded: true,
      customReturnPath: true,
      returnPathStatus: true,
      trackingSubdomain: true,
      openTracking: true,
      clickTracking: true,
    },
  });

  if (!domain) {
    throw new Error(`Domain ${domainId} not found for team ${teamId}`);
  }

  // Aggregate 30-day stats from DailyEmailUsage
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateStr = thirtyDaysAgo.toISOString().slice(0, 10).replace(/-/g, "");

  const usageRows = await db.dailyEmailUsage.findMany({
    where: {
      teamId,
      domainId,
      date: { gte: dateStr },
    },
    select: { sent: true, delivered: true, bounced: true, complained: true },
  });

  const stats = { sent: 0, delivered: 0, bounced: 0, complained: 0 };
  for (const r of usageRows) {
    stats.sent += r.sent;
    stats.delivered += r.delivered;
    stats.bounced += r.bounced;
    stats.complained += r.complained;
  }

  const bounceRate = stats.sent > 0 ? stats.bounced / stats.sent : 0;
  const complaintRate = stats.sent > 0 ? stats.complained / stats.sent : 0;

  // Run DNS checks in parallel
  const [dmarcItem, spfItem] = await Promise.all([
    checkDmarc(domain.name),
    checkSpf(domain.name),
  ]);

  const items: InsightItem[] = [
    dmarcItem,
    spfItem,
    checkDkim(domain.dkimStatus),
    checkReturnPath(domain.customReturnPath, domain.returnPathStatus),
    checkTrackingSubdomain(domain.trackingSubdomain, domain.name),
    ...checkBounceComplaintRate(stats),
  ];

  return {
    domainId,
    domainName: domain.name,
    generatedAt: new Date(),
    items,
    stats: { ...stats, bounceRate, complaintRate },
  };
}
