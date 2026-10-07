/**
 * Internal HTTP endpoint used by the inbound MX server (apps/smtp-server) to
 * persist received emails.
 *
 * POST /api/internal/inbound — store a received email.
 * GET  /api/internal/inbound/domains — return all receiving-enabled domain names.
 *
 * Protected by the shared `INBOUND_INTERNAL_SECRET` env var.  Requests without
 * a matching `X-Internal-Secret` header are rejected with 401.  Never expose
 * this route externally; it is intended for same-host or private-network calls.
 */

import { z } from "zod";
import { env } from "~/env";
import { db } from "~/server/db";
import { persistReceivedEmail } from "~/server/service/received-email-service";

export const dynamic = "force-dynamic";

import { checkInternalSecret } from "~/server/internal/internal-secret";

// ─── GET /api/internal/inbound/domains ────────────────────────────────────────
// This is handled by /api/internal/inbound/domains/route.ts but we expose it
// here via Next.js catch-all via a named export to keep file count low.
// Actually Next.js route files don't have sub-routes; we use a separate file.

// ─── POST /api/internal/inbound ───────────────────────────────────────────────

const AttachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string().nullish(),
  contentId: z.string().nullish(),
  contentDisposition: z.string().nullish(),
  sizeBytes: z.number().int().nonnegative(),
  storageKey: z.string(),
});

const InboundMailSchema = z.object({
  recipientDomain: z.string().min(1),
  messageId: z.string().nullish(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  replyTo: z.array(z.string()).optional(),
  subject: z.string(),
  text: z.string().nullish(),
  html: z.string().nullish(),
  headers: z.record(z.string()).optional(),
  rawStorageKey: z.string().nullish(),
  sizeBytes: z.number().int().nonnegative(),
  spfResult: z.string().nullish(),
  dkimResult: z.string().nullish(),
  dmarcResult: z.string().nullish(),
  spamScore: z.number().nullish(),
  attachments: z.array(AttachmentSchema).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const authError = checkInternalSecret(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = InboundMailSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation error", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  try {
    const id = await persistReceivedEmail(parsed.data);
    return Response.json({ id }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("NOT_FOUND") ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}
