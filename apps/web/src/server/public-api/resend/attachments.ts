/**
 * Resend /emails/:id/attachments routes (Wave 2 B3).
 *
 * GET /emails/:emailId/attachments              – list
 * GET /emails/:emailId/attachments/:attachmentId – get one (signed URL)
 */
import { AttachmentService } from "~/server/service/attachment-service";
import type { ResendApp } from "./app";

function presentAttachment(a: {
  id: string;
  filename: string;
  contentType: string | null;
  contentId: string | null;
  inline: boolean;
  sizeBytes: number | null;
  url: string | null;
  createdAt: Date;
}) {
  return {
    object: "attachment" as const,
    id: a.id,
    filename: a.filename,
    content_type: a.contentType,
    content_id: a.contentId,
    inline: a.inline,
    size_bytes: a.sizeBytes,
    url: a.url,
    created_at: a.createdAt.toISOString(),
  };
}

export function registerAttachmentRoutes(app: ResendApp): void {
  app.get("/emails/:emailId/attachments", async (c) => {
    const attachments = await AttachmentService.list(
      c.var.team.id,
      c.req.param("emailId"),
    );
    return c.json(
      { object: "list", data: attachments.map(presentAttachment) },
      200,
    );
  });

  app.get("/emails/:emailId/attachments/:attachmentId", async (c) => {
    const attachment = await AttachmentService.get(
      c.var.team.id,
      c.req.param("emailId"),
      c.req.param("attachmentId"),
    );
    return c.json(presentAttachment(attachment), 200);
  });
}
