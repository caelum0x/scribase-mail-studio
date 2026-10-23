/**
 * Resend-compatible "received emails" endpoints.
 *
 * Resend API reference (Scribase Mail extensions beyond Resend proper are
 * marked below; Resend itself has no inbound-reply endpoint):
 *   GET  /emails/received              — list received emails
 *   GET  /emails/received/:id          — get one received email
 *   GET  /emails/received/:id/attachments       — list attachments
 *   GET  /emails/received/:id/attachments/:aid  — get one attachment
 *   POST /emails/received/:id/reply    — reply to a received email (Scribase Mail extension)
 *
 * All endpoints require a team API key with `FULL` permission.
 */

import { z } from "zod";
import { db } from "~/server/db";
import {
  getReceivedEmails,
  getReceivedEmailById,
  replyToReceivedEmail,
  toResendReceivedEmail,
} from "~/server/service/received-email-service";
import { getStorageSignedDownloadUrl } from "~/server/service/inbound-storage-service";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";
import { parseCursorParams } from "./pagination";

const replyToReceivedEmailSchema = z.object({
  from: z.string().min(1, "`from` is required"),
  to: z.string().optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  text: z.string().optional(),
  html: z.string().optional(),
});

export function registerReceivedEmailRoutes(app: ResendApp): void {
  // GET /emails/received — cursor-paginated list of received emails.
  app.get("/emails/received", async (c) => {
    const team = c.var.team;
    const params = parseCursorParams(c.req.query());

    const { data, has_more } = await getReceivedEmails(team.id, {
      limit: params.limit,
      after: params.after,
      before: params.before,
    });

    const resendData = await Promise.all(data.map(toResendReceivedEmail));
    return c.json({ object: "list", has_more, data: resendData }, 200);
  });

  // GET /emails/received/:id — get one received email.
  app.get("/emails/received/:id", async (c) => {
    const team = c.var.team;
    const row = await getReceivedEmailById(team.id, c.req.param("id"));
    if (!row) {
      throw new ResendApiError("not_found", "Received email not found");
    }
    return c.json(await toResendReceivedEmail(row), 200);
  });

  // POST /emails/received/:id/reply — send a threaded reply to a received
  // email. Scribase Mail extension; not part of the Resend API proper, so
  // SDKs that only know Resend's surface simply won't call this. Reuses the
  // native send pipeline (quota, screening, suppression checks all apply).
  app.post("/emails/received/:id/reply", async (c) => {
    const team = c.var.team;
    const body = replyToReceivedEmailSchema.parse(await readJsonBody(c));
    const cc = Array.isArray(body.cc)
      ? body.cc
      : body.cc
        ? [body.cc]
        : undefined;

    const sent = await replyToReceivedEmail(team.id, c.req.param("id"), {
      from: body.from,
      to: body.to,
      cc,
      text: body.text,
      html: body.html,
    });

    return c.json({ id: sent.id }, 200);
  });

  // GET /emails/received/:id/attachments — list all attachments.
  app.get("/emails/received/:id/attachments", async (c) => {
    const team = c.var.team;
    const email = await db.receivedEmail.findFirst({
      where: { id: c.req.param("id"), teamId: team.id },
      select: {
        id: true,
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
      },
    });

    if (!email) {
      throw new ResendApiError("not_found", "Received email not found");
    }

    const attachments = await Promise.all(
      email.attachments.map(async (att) => {
        let downloadUrl: string | null = null;
        try {
          downloadUrl = await getStorageSignedDownloadUrl(att.storageKey);
        } catch {
          // Non-fatal
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

    return c.json({ object: "list", has_more: false, data: attachments }, 200);
  });

  // GET /emails/received/:id/attachments/:aid — get one attachment with URL.
  app.get("/emails/received/:id/attachments/:aid", async (c) => {
    const team = c.var.team;
    const email = await db.receivedEmail.findFirst({
      where: { id: c.req.param("id"), teamId: team.id },
      select: { id: true },
    });
    if (!email) {
      throw new ResendApiError("not_found", "Received email not found");
    }

    const att = await db.receivedEmailAttachment.findFirst({
      where: { id: c.req.param("aid"), receivedEmailId: email.id },
    });
    if (!att) {
      throw new ResendApiError("not_found", "Attachment not found");
    }

    let downloadUrl: string | null = null;
    try {
      downloadUrl = await getStorageSignedDownloadUrl(att.storageKey);
    } catch {
      // Non-fatal
    }

    return c.json(
      {
        object: "received_email_attachment",
        id: att.id,
        filename: att.filename,
        content_type: att.contentType,
        content_id: att.contentId,
        content_disposition: att.contentDisposition,
        size: att.sizeBytes,
        download_url: downloadUrl,
        created_at: att.createdAt.toISOString(),
      },
      200,
    );
  });
}
