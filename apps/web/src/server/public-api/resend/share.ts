/**
 * Resend POST /emails/:id/share route (Wave 2 B3).
 *
 * Creates a public, expiring, read-only link to view an email in the browser.
 * Stores an EmailShare record and returns a signed token URL.
 */
import { randomBytes } from "crypto";
import { db } from "~/server/db";
import { env } from "~/env";
import type { ResendApp } from "./app";
import { ResendApiError } from "./errors";

const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function buildShareUrl(token: string): string {
  const base = env.NEXTAUTH_URL ?? "http://localhost:3000";
  return `${base}/share/${token}`;
}

export function registerShareRoutes(app: ResendApp): void {
  app.post("/emails/:id/share", async (c) => {
    const teamId = c.var.team.id;
    const emailId = c.req.param("id");

    const email = await db.email.findFirst({
      where: { id: emailId, teamId },
      select: { id: true },
    });
    if (!email) throw new ResendApiError("not_found", "Email not found");

    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + SHARE_TTL_MS);

    await db.emailShare.create({
      data: { emailId, teamId, token, expiresAt },
    });

    return c.json(
      {
        object: "email_share",
        email_id: emailId,
        url: buildShareUrl(token),
        expires_at: expiresAt.toISOString(),
      },
      201,
    );
  });
}
