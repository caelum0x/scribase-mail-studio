import { z } from "zod";
import type { Domain, DomainStatus, DomainTlsMode } from "@prisma/client";
import type { DomainDnsRecord } from "~/types/domain";
import {
  createDomain,
  getDomain,
  getDomains,
  updateDomain,
  deleteDomain,
  refreshDomainVerification,
} from "~/server/service/domain-service";
import { db } from "~/server/db";
import { UnsendApiError } from "../api-error";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";

// ---------------------------------------------------------------------------
// Resend region <-> OCI region mapping
// ---------------------------------------------------------------------------

const RESEND_TO_OCI_REGION: Record<string, string> = {
  "us-east-1": "us-ashburn-1",
  "eu-west-1": "eu-frankfurt-1",
  "sa-east-1": "sa-saopaulo-1",
  "ap-northeast-1": "ap-tokyo-1",
};

const OCI_TO_RESEND_REGION: Record<string, string> = Object.fromEntries(
  Object.entries(RESEND_TO_OCI_REGION).map(([r, o]) => [o, r]),
);

export function ociToResendRegion(ociRegion: string): string {
  return OCI_TO_RESEND_REGION[ociRegion] ?? ociRegion;
}

export function resendToOciRegion(resendRegion: string): string {
  return RESEND_TO_OCI_REGION[resendRegion] ?? resendRegion;
}

// ---------------------------------------------------------------------------
// Resend domain response shape
// ---------------------------------------------------------------------------

export type ResendDomainRecord = {
  record: string;
  name: string;
  type: string;
  ttl: string;
  status: string;
  value: string;
  priority?: number;
};

export type ResendDomain = {
  object: "domain";
  id: string;
  name: string;
  status: string;
  created_at: string;
  region: string;
  records: ResendDomainRecord[];
  dns_provider?: string;
  open_tracking: boolean;
  click_tracking: boolean;
  tls: "opportunistic" | "enforced";
};

function mapDomainStatus(status: DomainStatus, isVerifying: boolean): string {
  if (isVerifying) return "pending";
  switch (status) {
    case "SUCCESS":
      return "success";
    case "FAILED":
      return "failed";
    case "TEMPORARY_FAILURE":
      return "temporary_failure";
    case "NOT_STARTED":
    case "PENDING":
    default:
      return "not_started";
  }
}

function mapTlsMode(mode: DomainTlsMode): "opportunistic" | "enforced" {
  return mode === "ENFORCED" ? "enforced" : "opportunistic";
}

function mapDnsRecord(record: DomainDnsRecord): ResendDomainRecord {
  const status = (() => {
    switch (record.status) {
      case "SUCCESS":
        return "verified";
      case "FAILED":
      case "TEMPORARY_FAILURE":
        return "failed";
      default:
        return "not_started";
    }
  })();

  // Determine the Resend `record` label from the type and context.
  let label = "CUSTOM";
  if (record.type === "CNAME" && record.name.includes("_domainkey")) {
    label = "DKIM";
  } else if (record.type === "TXT" && record.value.includes("v=spf1")) {
    label = "SPF";
  } else if (record.name === "_dmarc") {
    label = "DMARC";
  } else if (record.type === "MX" || record.name.includes("return-path")) {
    label = "Return-Path";
  }

  return {
    record: label,
    name: record.name,
    type: record.type,
    ttl: record.ttl,
    status,
    value: record.value,
    ...(record.priority !== undefined && record.priority !== null
      ? { priority: Number(record.priority) }
      : {}),
  };
}

function toResendDomain(
  domain: Domain & { dnsRecords: DomainDnsRecord[] },
): ResendDomain {
  return {
    object: "domain",
    id: String(domain.id),
    name: domain.name,
    status: mapDomainStatus(domain.status, domain.isVerifying),
    created_at: domain.createdAt.toISOString(),
    region: ociToResendRegion(domain.region),
    records: domain.dnsRecords.map(mapDnsRecord),
    open_tracking: domain.openTracking,
    click_tracking: domain.clickTracking,
    tls: mapTlsMode(domain.tlsMode),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerDomainRoutes(app: ResendApp): void {
  // POST /domains — create a domain.
  app.post("/domains", async (c) => {
    const team = c.var.team;
    const body = z
      .object({
        name: z.string().min(1),
        region: z.string().optional(),
      })
      .strict()
      .parse(await readJsonBody(c));

    const ociRegion = body.region
      ? resendToOciRegion(body.region)
      : undefined;

    try {
      const domain = await createDomain(team.id, body.name, ociRegion);
      return c.json(toResendDomain(domain), 201);
    } catch (err) {
      if (err instanceof UnsendApiError) throw err;
      throw new ResendApiError(
        "validation_error",
        err instanceof Error ? err.message : "Failed to create domain.",
      );
    }
  });

  // GET /domains — list all domains.
  app.get("/domains", async (c) => {
    const team = c.var.team;
    const domains = await getDomains(team.id, {
      domainId: team.apiKey.domainId ?? undefined,
    });
    return c.json(
      { object: "list", data: domains.map(toResendDomain) },
      200,
    );
  });

  // GET /domains/:id — get one domain.
  app.get("/domains/:id", async (c) => {
    const team = c.var.team;
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    if (team.apiKey.domainId !== null && team.apiKey.domainId !== id) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    try {
      const domain = await getDomain(id, team.id);
      return c.json(toResendDomain(domain), 200);
    } catch (err) {
      if (err instanceof UnsendApiError && err.code === "NOT_FOUND") {
        throw new ResendApiError("not_found", "Domain not found");
      }
      throw err;
    }
  });

  // PATCH /domains/:id — update open/click tracking and tls.
  app.patch("/domains/:id", async (c) => {
    const team = c.var.team;
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    if (team.apiKey.domainId !== null && team.apiKey.domainId !== id) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    const body = z
      .object({
        open_tracking: z.boolean().optional(),
        click_tracking: z.boolean().optional(),
        tls: z.enum(["opportunistic", "enforced"]).optional(),
      })
      .strict()
      .parse(await readJsonBody(c));

    // Verify the domain belongs to this team.
    const existing = await db.domain.findFirst({
      where: { id, teamId: team.id },
      select: { id: true },
    });
    if (!existing) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    if (body.tls === "enforced") {
      // OCI does not currently support enforced TLS; store the preference but warn.
      // Resend itself returns 422 for enforced until it's available.
      throw new ResendApiError(
        "validation_error",
        "Enforced TLS is not yet supported on this provider. Use 'opportunistic'.",
        422,
      );
    }

    await updateDomain(id, {
      ...(body.open_tracking !== undefined
        ? { openTracking: body.open_tracking }
        : {}),
      ...(body.click_tracking !== undefined
        ? { clickTracking: body.click_tracking }
        : {}),
      ...(body.tls !== undefined
        ? { tlsMode: "OPPORTUNISTIC" as const }
        : {}),
    });

    const updated = await getDomain(id, team.id);
    return c.json(toResendDomain(updated), 200);
  });

  // DELETE /domains/:id — delete a domain.
  app.delete("/domains/:id", async (c) => {
    const team = c.var.team;
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    if (team.apiKey.domainId !== null && team.apiKey.domainId !== id) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    // Verify ownership before deleting.
    const existing = await db.domain.findFirst({
      where: { id, teamId: team.id },
      select: { id: true },
    });
    if (!existing) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    try {
      await deleteDomain(id);
    } catch (err) {
      throw new ResendApiError(
        "application_error",
        err instanceof Error ? err.message : "Failed to delete domain.",
      );
    }

    return c.json({ object: "domain", id: String(id), deleted: true }, 200);
  });

  // POST /domains/:id/verify — trigger domain verification.
  app.post("/domains/:id/verify", async (c) => {
    const team = c.var.team;
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    if (team.apiKey.domainId !== null && team.apiKey.domainId !== id) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    const domain = await db.domain.findFirst({
      where: { id, teamId: team.id },
    });
    if (!domain) {
      throw new ResendApiError("not_found", "Domain not found");
    }

    // Trigger a real DNS check and update the domain status.
    const refreshed = await refreshDomainVerification(domain);
    return c.json(toResendDomain(refreshed), 200);
  });
}
