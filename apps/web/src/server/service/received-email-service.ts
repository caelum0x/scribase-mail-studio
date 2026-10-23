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
import {
  getStorageSignedDownloadUrl,
  getStorageObjectBytes,
} from "./inbound-storage-service";
import { logger } from "~/server/logger/log";
import { sendEmail } from "./email-service";
import type { EmailAttachment } from "~/types";

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
  messageId: true,
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
  messageId: string | null;
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

// ─── Reply ────────────────────────────────────────────────────────────────

/** Strip a display name and angle brackets, e.g. `"Jane" <jane@x.com>` -> `jane@x.com`. */
function extractBareAddress(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return (match?.[1] ?? address).trim();
}

/** Normalize a Message-ID into the bracketed form used in References/In-Reply-To. */
function toBracketedMessageId(messageId: string): string {
  const trimmed = messageId.trim();
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

/**
 * Build the outgoing `References` header for a reply, chaining onto the
 * original message's own `References` (captured verbatim on inbound, see
 * `apps/smtp-server/src/inbound/server.ts`) so that replying to a message
 * that is itself a reply-of-a-reply still threads correctly in the
 * recipient's mail client beyond a single hop, per RFC 5322 §3.6.4.
 */
function buildReferencesChain(original: ReceivedEmailRow): string | undefined {
  const headers =
    original.headers && typeof original.headers === "object"
      ? (original.headers as Record<string, unknown>)
      : {};
  const priorReferences =
    typeof headers.references === "string" ? headers.references.trim() : "";
  const ownMessageId = original.messageId
    ? toBracketedMessageId(original.messageId)
    : "";

  // Avoid duplicating the original's own id if it was already (incorrectly)
  // present at the end of its own References header.
  const priorIds = priorReferences.length > 0 ? priorReferences.split(/\s+/) : [];
  const chain =
    ownMessageId && !priorIds.includes(ownMessageId)
      ? [...priorIds, ownMessageId]
      : priorIds;

  return chain.length > 0 ? chain.join(" ") : undefined;
}

export type ReplyToReceivedEmailInput = {
  /** Verified sender address on this team's domain, e.g. the address the mail was received at. */
  from: string;
  /** Override the reply recipient; defaults to the original sender. */
  to?: string;
  cc?: string[];
  text?: string;
  html?: string;
};

/**
 * Send a reply to a received (inbound) email, threaded via In-Reply-To /
 * References headers so it lands in the same thread in the recipient's
 * mail client. Reuses the existing outbound send pipeline (quota, screening,
 * suppression checks all still apply).
 */
export async function replyToReceivedEmail(
  teamId: number,
  receivedEmailId: string,
  input: ReplyToReceivedEmailInput,
) {
  const original = await getReceivedEmailById(teamId, receivedEmailId);
  if (!original) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Received email not found",
    });
  }

  if (!input.text && !input.html) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "Either text or html is required",
    });
  }

  const replyTo = input.to ?? extractBareAddress(original.from);
  const subject = /^re:/i.test(original.subject)
    ? original.subject
    : `Re: ${original.subject}`;

  const headers: Record<string, string> = {};
  if (original.messageId) {
    headers["In-Reply-To"] = toBracketedMessageId(original.messageId);
  }
  const references = buildReferencesChain(original);
  if (references) {
    headers["References"] = references;
  }

  const sent = await sendEmail({
    teamId,
    from: input.from,
    to: replyTo,
    cc: input.cc,
    subject,
    text: input.text,
    html: input.html,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  logger.info(
    { receivedEmailId, emailId: sent.id, teamId },
    "Sent reply to received email",
  );

  return sent;
}

// ─── Forward ──────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Classic "forwarded message" quote header, à la Gmail/Outlook. */
function buildForwardedHeaderBlock(original: ReceivedEmailRow): string {
  return [
    "---------- Forwarded message ---------",
    `From: ${original.from}`,
    `Date: ${original.createdAt.toUTCString()}`,
    `Subject: ${original.subject}`,
    `To: ${original.to.join(", ")}`,
  ].join("\n");
}

export type ForwardReceivedEmailInput = {
  /** Verified sender address on this team's domain. */
  from: string;
  /** Forward recipient(s). */
  to: string | string[];
  cc?: string[];
  /** Optional note prepended above the quoted original message. */
  comment?: string;
};

/**
 * Forward a received (inbound) email to a new recipient, carrying over the
 * original attachments by reading their bytes from the inbound storage
 * object directly (`getStorageObjectBytes`) rather than re-uploading them
 * anywhere — the storage key on `ReceivedEmailAttachment` is reused as-is,
 * just read once to build the outgoing MIME attachment. Goes through the
 * normal outbound send pipeline (quota, screening, suppression checks all
 * apply, same as a regular send or a reply).
 */
export async function forwardReceivedEmail(
  teamId: number,
  receivedEmailId: string,
  input: ForwardReceivedEmailInput,
) {
  const original = await getReceivedEmailById(teamId, receivedEmailId);
  if (!original) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Received email not found",
    });
  }

  const toAddresses = (Array.isArray(input.to) ? input.to : [input.to])
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0);
  if (toAddresses.length === 0) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "`to` is required",
    });
  }

  const subject = /^fwd:/i.test(original.subject)
    ? original.subject
    : `Fwd: ${original.subject}`;

  const comment = input.comment?.trim();
  const headerBlock = buildForwardedHeaderBlock(original);

  let text: string | undefined;
  let html: string | undefined;

  if (original.html) {
    const commentHtml = comment ? `<p>${escapeHtml(comment)}</p>` : "";
    const headerHtml = headerBlock
      .split("\n")
      .map((line) => escapeHtml(line))
      .join("<br/>");
    html = `${commentHtml}<p>${headerHtml}</p>${original.html}`;
    text = original.text
      ? `${comment ? `${comment}\n\n` : ""}${headerBlock}\n\n${original.text}`
      : undefined;
  } else {
    text = `${comment ? `${comment}\n\n` : ""}${headerBlock}${
      original.text ? `\n\n${original.text}` : ""
    }`;
  }

  // Reuse the original attachment bytes by storage key — read once, no
  // re-upload. Non-fatal per-attachment: a storage read failure drops that
  // one attachment instead of blocking the whole forward.
  const attachmentResults = await Promise.all(
    original.attachments.map(async (att): Promise<EmailAttachment | null> => {
      try {
        const bytes = await getStorageObjectBytes(att.storageKey);
        return {
          filename: att.filename,
          content: bytes.toString("base64"),
          ...(att.contentType ? { contentType: att.contentType } : {}),
          ...(att.contentId
            ? { cid: att.contentId.replace(/[<>]/g, "") }
            : {}),
        };
      } catch (err) {
        logger.error(
          { err, receivedEmailId, attachmentId: att.id },
          "Failed to read inbound attachment for forward; skipping it",
        );
        return null;
      }
    }),
  );
  const attachments = attachmentResults.filter(
    (att): att is EmailAttachment => att !== null,
  );

  const sent = await sendEmail({
    teamId,
    from: input.from,
    to: toAddresses,
    cc: input.cc,
    subject,
    text,
    html,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  logger.info(
    { receivedEmailId, emailId: sent.id, teamId, attachmentCount: attachments.length },
    "Forwarded received email",
  );

  return sent;
}
