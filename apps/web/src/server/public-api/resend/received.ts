/**
 * Resend-compatible "received emails" endpoints.
 *
 * Resend API reference:
 *   GET  /emails/received              — list received emails
 *   GET  /emails/received/:id          — get one received email
 *   GET  /emails/received/:id/attachments       — list attachments
 *   GET  /emails/received/:id/attachments/:aid  — get one attachment
 *
 * All endpoints require a team API key with `FULL` permission.
 */

import { db } from "~/server/db";
import {
  getReceivedEmails,
  getReceivedEmailById,
  toResendReceivedEmail,
} from "~/server/service/received-email-service";
import { getStorageSignedDownloadUrl } from "~/server/service/inbound-storage-service";
import type { ResendApp } from "./app";
import { ResendApiError } from "./errors";
import { parseCursorParams } from "./pagination";

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
