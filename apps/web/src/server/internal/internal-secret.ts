import { timingSafeEqual } from "crypto";

/**
 * Auth for internal endpoints called by the MX server. Fails closed: without
 * INBOUND_INTERNAL_SECRET configured every request is refused, because these
 * routes are reachable on the public host.
 */
export function checkInternalSecret(
  request: Request,
  secret: string | undefined = process.env.INBOUND_INTERNAL_SECRET,
): Response | null {
  if (!secret) {
    return Response.json(
      { error: "Inbound is not configured" },
      { status: 503 },
    );
  }
  const header = request.headers.get("X-Internal-Secret") ?? "";
  const given = Buffer.from(header);
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
