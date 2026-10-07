/**
 * GET /api/internal/inbound/domains
 *
 * Returns all domain names that have `receivingEnabled = true`.
 * The inbound MX server polls this every 5 minutes to keep its allowlist fresh.
 */

export const dynamic = "force-dynamic";

import { db } from "~/server/db";

import { checkInternalSecret } from "~/server/internal/internal-secret";

export async function GET(request: Request): Promise<Response> {
  const denied = checkInternalSecret(request);
  if (denied) return denied;

  const domains = await db.domain.findMany({
    where: { receivingEnabled: true },
    select: { name: true },
  });

  return Response.json({ domains: domains.map((d) => d.name) });
}
