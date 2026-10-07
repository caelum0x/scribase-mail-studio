/**
 * GET /api/internal/inbound/domains
 *
 * Returns all domain names that have `receivingEnabled = true`.
 * The inbound MX server polls this every 5 minutes to keep its allowlist fresh.
 */

export const dynamic = "force-dynamic";

import { db } from "~/server/db";

const INTERNAL_SECRET = process.env.INBOUND_INTERNAL_SECRET ?? "";
const SECRET_CONFIGURED = INTERNAL_SECRET.length > 0;

export async function GET(request: Request): Promise<Response> {
  if (SECRET_CONFIGURED) {
    const header = request.headers.get("X-Internal-Secret");
    if (!header || header !== INTERNAL_SECRET) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const domains = await db.domain.findMany({
    where: { receivingEnabled: true },
    select: { name: true },
  });

  return Response.json({ domains: domains.map((d) => d.name) });
}
