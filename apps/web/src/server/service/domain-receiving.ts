/**
 * Helpers for the domain receiving feature (inbound MX).
 *
 * Kept in a separate file so this agent's changes are isolated from the
 * domain-service.ts edits other Wave-3 work might touch.
 */

import { db } from "~/server/db";
import { UnsendApiError } from "../public-api/api-error";
import type { Domain } from "@prisma/client";
import type { DomainDnsRecord } from "~/types/domain";
import { DomainStatus } from "@prisma/client";

/** The MX hostname where inbound email should be delivered. */
export const INBOUND_MX_HOSTNAME =
  process.env.INBOUND_MX_HOSTNAME ?? "inbound.scribase.com";

/**
 * Build the MX record entry to show in the domain's DNS record list when
 * receiving is enabled.
 */
export function buildMxRecord(domain: Domain): DomainDnsRecord {
  return {
    type: "MX",
    name: "@",
    value: `10 ${INBOUND_MX_HOSTNAME}.`,
    ttl: "Auto",
    priority: "10",
    // Mark as NOT_STARTED: we have no way to verify the customer set it up
    // without doing a live DNS query; the domain-verification job can check
    // MX records in a future pass.
    status: DomainStatus.NOT_STARTED,
    recommended: false,
  };
}

/** Toggle `receivingEnabled` for a domain owned by the given team. */
export async function setDomainReceiving(
  teamId: number,
  domainId: number,
  enabled: boolean,
): Promise<Domain> {
  const domain = await db.domain.findFirst({
    where: { id: domainId, teamId },
  });
  if (!domain) {
    throw new UnsendApiError({ code: "NOT_FOUND", message: "Domain not found" });
  }

  return db.domain.update({
    where: { id: domainId },
    data: { receivingEnabled: enabled },
  });
}

/** Return domains with receiving enabled for a team. */
export async function getReceivingDomains(
  teamId: number,
): Promise<Domain[]> {
  return db.domain.findMany({
    where: { teamId, receivingEnabled: true },
  });
}
