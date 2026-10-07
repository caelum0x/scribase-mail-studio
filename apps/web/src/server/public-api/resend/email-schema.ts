import * as chrono from "chrono-node";
import { z } from "zod";
import type { EmailContent, EmailTag } from "~/types";
import { ResendApiError } from "./errors";

/**
 * Request schema for Resend's POST /emails, plus the mapping onto our
 * EmailContent. Every Resend field is either supported or rejected with an
 * explicit error; unknown keys are rejected (never silently dropped).
 */

export const MAX_TO_RECIPIENTS = 50;
export const MAX_SCHEDULE_DAYS = 30;
/** Resend's limit: 40 MB per email after base64 encoding. */
export const MAX_ATTACHMENTS_BYTES = 40 * 1024 * 1024;

const TAG_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/\r\n]*={0,2}[\r\n]*$/;
const ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Accepts "a@b.com" and "Name <a@b.com>". */
export function isValidAddress(value: string): boolean {
  const trimmed = value.trim();
  const match = trimmed.match(/<([^>]+)>\s*$/);
  const address = match?.[1] ?? trimmed;
  return ADDRESS_PATTERN.test(address.trim());
}

const address = z
  .string()
  .min(1)
  .refine(isValidAddress, { message: "Invalid email address" });
const addressList = z.union([address, z.array(address).min(1)]);

/** resend-node JSON-serializes Buffers as { type: "Buffer", data: number[] }. */
const serializedBuffer = z
  .object({ type: z.literal("Buffer"), data: z.array(z.number().int()) })
  .strict();

const attachmentSchema = z
  .object({
    content: z.union([z.string(), serializedBuffer]).optional(),
    filename: z.string().min(1).optional(),
    path: z.string().optional(),
    content_type: z.string().optional(),
    content_id: z.string().optional(),
  })
  .strict();

const tagSchema = z
  .object({
    name: z.string().regex(TAG_PATTERN, {
      message:
        "Tag names may only contain ASCII letters, numbers, underscores or dashes (max 256).",
    }),
    value: z.string().regex(TAG_PATTERN, {
      message:
        "Tag values may only contain ASCII letters, numbers, underscores or dashes (max 256).",
    }),
  })
  .strict();

export const resendSendEmailSchema = z
  .object({
    from: address,
    to: addressList,
    subject: z.string().min(1).optional(),
    bcc: addressList.optional(),
    cc: addressList.optional(),
    reply_to: addressList.optional(),
    html: z.string().optional(),
    text: z.string().optional(),
    react: z.unknown().optional(),
    headers: z.record(z.string()).optional(),
    scheduled_at: z.string().min(1).optional(),
    attachments: z.array(attachmentSchema).optional(),
    tags: z.array(tagSchema).optional(),
    template: z
      .object({
        id: z.string().min(1),
        variables: z.record(z.union([z.string(), z.number()])).optional(),
      })
      .strict()
      .optional(),
    topic_id: z.string().optional(),
  })
  .strict();

export type ResendSendEmailInput = z.infer<typeof resendSendEmailSchema>;

const toArray = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** ISO 8601 or natural language ("in 1 min", "tomorrow at 9am"). */
export function parseResendScheduledAt(value: string, now = new Date()): Date {
  const looksIso = /^\d{4}-\d{2}-\d{2}/.test(value.trim());
  const parsed = looksIso
    ? new Date(value)
    : chrono.parseDate(value, now, { forwardDate: true });

  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new ResendApiError(
      "validation_error",
      "Invalid `scheduled_at`. Use an ISO 8601 date or natural language like 'in 1 min'.",
    );
  }
  if (parsed.getTime() < now.getTime() - 60_000) {
    throw new ResendApiError(
      "validation_error",
      "`scheduled_at` must be in the future.",
    );
  }
  const maxMs = MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000;
  if (parsed.getTime() - now.getTime() > maxMs) {
    throw new ResendApiError(
      "validation_error",
      `\`scheduled_at\` cannot be more than ${MAX_SCHEDULE_DAYS} days in the future.`,
    );
  }
  return parsed;
}

function toAttachments(
  attachments: ResendSendEmailInput["attachments"],
): EmailContent["attachments"] {
  if (!attachments || attachments.length === 0) return undefined;

  let totalBytes = 0;
  const mapped = attachments.map((attachment, index) => {
    if (attachment.path !== undefined) {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}].path is not supported yet; send the file as base64 \`content\`.`,
      );
    }
    if (attachment.content_id !== undefined) {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}].content_id (inline images) is not supported yet.`,
      );
    }
    if (attachment.content_type !== undefined) {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}].content_type is not supported yet; the type is derived from the filename.`,
      );
    }
    if (attachment.content === undefined || attachment.content === "") {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}] must include \`content\`.`,
      );
    }
    if (!attachment.filename) {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}] must include \`filename\`.`,
      );
    }

    const content =
      typeof attachment.content === "string"
        ? attachment.content
        : Buffer.from(attachment.content.data).toString("base64");

    if (!BASE64_PATTERN.test(content)) {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}].content must be base64 encoded.`,
      );
    }
    totalBytes += content.length;

    return { filename: attachment.filename, content };
  });

  if (totalBytes > MAX_ATTACHMENTS_BYTES) {
    throw new ResendApiError(
      "invalid_attachment",
      "Attachments exceed the 40 MB limit per email.",
    );
  }
  return mapped;
}

function toVariables(
  variables: Record<string, string | number> | undefined,
): Record<string, string> | undefined {
  if (!variables) return undefined;
  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [key, String(value)]),
  );
}

/**
 * Validate Resend-only rules and map to the camelCase EmailContent used by
 * the existing send pipeline. `resolveTemplateId` maps an id or alias to a
 * template id owned by the team.
 */
export async function toEmailContent(
  input: ResendSendEmailInput,
  resolveTemplateId: (idOrAlias: string) => Promise<string>,
  now = new Date(),
): Promise<EmailContent> {
  if (input.react !== undefined) {
    throw new ResendApiError(
      "validation_error",
      "`react` must be rendered to HTML before sending. The Resend SDK does this automatically when @react-email/render is installed.",
    );
  }
  if (input.topic_id !== undefined) {
    throw new ResendApiError(
      "validation_error",
      "`topic_id` is not supported yet.",
    );
  }

  const to = toArray(input.to);
  if (to.length > MAX_TO_RECIPIENTS) {
    throw new ResendApiError(
      "validation_error",
      `\`to\` supports a maximum of ${MAX_TO_RECIPIENTS} recipients.`,
    );
  }

  if (input.template) {
    if (input.html !== undefined || input.text !== undefined) {
      throw new ResendApiError(
        "validation_error",
        "`template` cannot be combined with `html` or `text`.",
      );
    }
  } else {
    if (!input.subject) {
      throw new ResendApiError(
        "missing_required_field",
        "Missing `subject` field.",
      );
    }
    if (!input.html && !input.text) {
      throw new ResendApiError(
        "missing_required_field",
        "Missing `html` or `text` field.",
      );
    }
  }

  const tags: EmailTag[] | undefined = input.tags?.map((tag) => ({
    name: tag.name,
    value: tag.value,
  }));

  return {
    from: input.from,
    to,
    subject: input.subject,
    ...(input.cc !== undefined ? { cc: toArray(input.cc) } : {}),
    ...(input.bcc !== undefined ? { bcc: toArray(input.bcc) } : {}),
    ...(input.reply_to !== undefined ? { replyTo: toArray(input.reply_to) } : {}),
    ...(input.html ? { html: input.html } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.scheduled_at
      ? { scheduledAt: parseResendScheduledAt(input.scheduled_at, now).toISOString() }
      : {}),
    ...(input.attachments ? { attachments: toAttachments(input.attachments) } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(input.template
      ? {
          templateId: await resolveTemplateId(input.template.id),
          variables: toVariables(input.template.variables),
        }
      : {}),
  };
}
