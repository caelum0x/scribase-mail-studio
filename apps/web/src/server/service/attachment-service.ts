/**
 * Attachment service — EmailAttachment CRUD + OCI Object Storage signed URLs
 * (Wave 2 B3).
 *
 * Attachment bodies are stored in OCI Object Storage when `storageService` is
 * configured.  `storageKey` on EmailAttachment points to the object.  If
 * storage is not configured (self-hosted default) the attachment is stored as
 * base64 in `Email.attachments` (legacy behaviour).
 */
import { db } from "../db";
import {
  getStoragePublicUrl,
  isStorageConfigured,
} from "./storage-service";
import { UnsendApiError } from "../public-api/api-error";

export type AttachmentMeta = {
  id: string;
  filename: string;
  contentType: string | null;
  contentId: string | null;
  inline: boolean;
  sizeBytes: number | null;
  url: string | null;
  createdAt: Date;
};

function toMeta(row: {
  id: string;
  filename: string;
  contentType: string | null;
  contentId: string | null;
  inline: boolean;
  sizeBytes: number | null;
  storageKey: string | null;
  createdAt: Date;
}): AttachmentMeta {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    contentId: row.contentId,
    inline: row.inline,
    sizeBytes: row.sizeBytes,
    url: row.storageKey ? getStoragePublicUrl(row.storageKey) : null,
    createdAt: row.createdAt,
  };
}

const ATTACHMENT_SELECT = {
  id: true,
  filename: true,
  contentType: true,
  contentId: true,
  inline: true,
  sizeBytes: true,
  storageKey: true,
  createdAt: true,
} as const;

export class AttachmentService {
  static async list(teamId: number, emailId: string): Promise<AttachmentMeta[]> {
    // First verify email ownership.
    const email = await db.email.findFirst({
      where: { id: emailId, teamId },
      select: { id: true },
    });
    if (!email) {
      throw new UnsendApiError({ code: "NOT_FOUND", message: "Email not found" });
    }

    const rows = await db.emailAttachment.findMany({
      where: { emailId, teamId },
      select: ATTACHMENT_SELECT,
      orderBy: { createdAt: "asc" },
    });

    return rows.map(toMeta);
  }

  static async get(
    teamId: number,
    emailId: string,
    attachmentId: string,
  ): Promise<AttachmentMeta> {
    const row = await db.emailAttachment.findFirst({
      where: { id: attachmentId, emailId, teamId },
      select: ATTACHMENT_SELECT,
    });
    if (!row) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Attachment not found",
      });
    }
    return toMeta(row);
  }

  static isStorageAvailable(): boolean {
    return isStorageConfigured();
  }
}
