/**
 * Service for persisting and querying received (inbound) emails.
 *
 * Called from:
 *  - /api/internal/inbound (POST): persists a new received email.
 *  - /api/resend/emails/received (GET, GET /:id): public query API.
 */

import { db } from "~/server/db";
import { WebhookService } from "./webhook-service";
import { UnsendApiError } from "../public-api/api-error";
import { getStorageSignedDownloadUrl } from "./inbound-storage-service";
import { logger } from "~/server/logger/log";

export type AttachmentInput = {
  filename: string;
  contentType?: string | null;
  contentId?: string | null;
  contentDisposition?: string | null;
  sizeBytes: number;
  storageKey: string;
};

export type InboundMailInput = {
  /** Domain portion of the recipient address — used to resolve the team. */
  recipientDomain: string;
  messageId?: string | null;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string>;
  rawStorageKey?: string | null;
  sizeBytes: number;
  spfResult?: string | null;
  dkimResult?: string | null;
  dmarcResult?: string | null;
  spamScore?: number | null;
  attachments?: AttachmentInput[];
};

/**
 * Persist an inbound email and fire the `email.received` webhook.
 * Returns the created ReceivedEmail id.
 */
export async function persistReceivedEmail(
  input: InboundMailInput,
): Promise<string> {
  // Resolve the domain and its owning team.
  const domain = await db.domain.findUnique({
    where: { name: input.recipientDomain },
    select: { id: true, teamId: true, receivingEnabled: true },
  });

  if (!domain) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: `Domain not found: ${input.recipientDomain}`,
    });
  }

  if (!domain.receivingEnabled) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: `Domain ${input.recipientDomain} does not have receiving enabled`,
    });
  }

  const received = await db.receivedEmail.create({
    data: {
      teamId: domain.teamId,
      domainId: domain.id,
      messageId: input.messageId ?? null,
      from: input.from,
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      replyTo: input.replyTo ?? [],
      subject: input.subject,
      text: input.text ?? null,
      html: input.html ?? null,
      headers: input.headers ?? undefined,
      rawStorageKey: input.rawStorageKey ?? null,
      sizeBytes: input.sizeBytes,
      spfResult: input.spfResult ?? null,
      dkimResult: input.dkimResult ?? null,
      dmarcResult: input.dmarcResult ?? null,
      spamScore: input.spamScore ?? null,
      attachments: {
        createMany: {
          data: (input.attachments ?? []).map((att) => ({
            filename: att.filename,
            contentType: att.contentType ?? null,
            contentId: att.contentId ?? null,
            contentDisposition: att.contentDisposition ?? null,
            sizeBytes: att.sizeBytes,
            storageKey: att.storageKey,
          })),
        },
      },
    },
  });

  // Enqueue `email.received` webhook — fire-and-forget; never block the HTTP response.
  WebhookService.emit(domain.teamId, "email.received", {
    id: received.id,
    from: received.from,
    to: received.to,
    cc: received.cc,
    subject: received.subject,
    domainId: received.domainId,
    rawStorageKey: received.rawStorageKey,
    spfResult: received.spfResult,
    dkimResult: received.dkimResult,
    dmarcResult: received.dmarcResult,
    sizeBytes: received.sizeBytes,
    createdAt: received.createdAt.toISOString(),
  }, { domainId: domain.id })
    ?.catch((err: unknown) => {
    logger.error({ err, receivedId: received.id }, "Failed to enqueue email.received webhook");
  });

  return received.id;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

const RECEIVED_SELECT = {
  id: true,
  from: true,
  to: true,
  cc: true,
  bcc: true,
  replyTo: true,
  subject: true,
  text: true,
  html: true,
  headers: true,
  rawStorageKey: true,
  sizeBytes: true,
  spfResult: true,
  dkimResult: true,
  dmarcResult: true,
  spamScore: true,
  createdAt: true,
  domainId: true,
  attachments: {
    select: {
      id: true,
      filename: true,
      contentType: true,
      contentId: true,
      contentDisposition: true,
      sizeBytes: true,
      storageKey: true,
      createdAt: true,
    },
  },
} as const;

export type ReceivedEmailRow = {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  text: string | null;
  html: string | null;
  headers: unknown;
  rawStorageKey: string | null;
  sizeBytes: number;
  spfResult: string | null;
  dkimResult: string | null;
  dmarcResult: string | null;
  spamScore: number | null;
  createdAt: Date;
  domainId: number | null;
  attachments: {
    id: string;
    filename: string;
    contentType: string | null;
    contentId: string | null;
    contentDisposition: string | null;
    sizeBytes: number;
    storageKey: string;
    createdAt: Date;
  }[];
};

export async function getReceivedEmails(
  teamId: number,
  opts: { limit: number; after?: string; before?: string },
): Promise<{ data: ReceivedEmailRow[]; has_more: boolean }> {
  const { limit, after, before } = opts;

  let cursor: object | undefined;
  if (after) {
    const row = await db.receivedEmail.findFirst({
      where: { id: after, teamId },
      select: { id: true, createdAt: true },
    });
    if (row) {
      cursor = {
        OR: [
          { createdAt: { lt: row.createdAt } },
          { createdAt: row.createdAt, id: { lt: row.id } },
        ],
      };
    }
  } else if (before) {
    const row = await db.receivedEmail.findFirst({
      where: { id: before, teamId },
      select: { id: true, createdAt: true },
    });
    if (row) {
      cursor = {
        OR: [
          { createdAt: { gt: row.createdAt } },
          { createdAt: row.createdAt, id: { gt: row.id } },
        ],
      };
    }
  }

  const rows = await db.receivedEmail.findMany({
    where: cursor ? { AND: [{ teamId }, cursor] } : { teamId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: RECEIVED_SELECT,
  });

  const hasMore = rows.length > limit;
  return { data: rows.slice(0, limit) as ReceivedEmailRow[], has_more: hasMore };
}

export async function getReceivedEmailById(
  teamId: number,
  id: string,
): Promise<ReceivedEmailRow | null> {
  return db.receivedEmail.findFirst({
    where: { id, teamId },
    select: RECEIVED_SELECT,
  }) as Promise<ReceivedEmailRow | null>;
}

/**
 * Build a Resend-shaped received email object with signed attachment download URLs.
 */
export async function toResendReceivedEmail(row: ReceivedEmailRow): Promise<object> {
  const attachments = await Promise.all(
    row.attachments.map(async (att) => {
      let downloadUrl: string | null = null;
      try {
        downloadUrl = await getStorageSignedDownloadUrl(att.storageKey);
      } catch {
        // Non-fatal — the URL is optional
      }
      return {
        object: "received_email_attachment",
        id: att.id,
        filename: att.filename,
        content_type: att.contentType,
        content_id: att.contentId,
        content_disposition: att.contentDisposition,
        size: att.sizeBytes,
        download_url: downloadUrl,
        created_at: att.createdAt.toISOString(),
      };
    }),
  );

  return {
    object: "received_email",
    id: row.id,
    from: row.from,
    to: row.to,
    cc: row.cc.length > 0 ? row.cc : null,
    bcc: row.bcc.length > 0 ? row.bcc : null,
    reply_to: row.replyTo.length > 0 ? row.replyTo : null,
    subject: row.subject,
    text: row.text,
    html: row.html,
    size: row.sizeBytes,
    spf_result: row.spfResult,
    dkim_result: row.dkimResult,
    dmarc_result: row.dmarcResult,
    spam_score: row.spamScore,
    created_at: row.createdAt.toISOString(),
    attachments,
  };
}
