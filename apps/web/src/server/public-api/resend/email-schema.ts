import dns from "node:dns/promises";
import * as chrono from "chrono-node";
import { convert as htmlToText } from "html-to-text";
import { z } from "zod";
import type { EmailAttachment, EmailContent, EmailTag } from "~/types";
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
/** Fetch timeout for path attachments. */
const ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

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

// ---------------------------------------------------------------------------
// SSRF guard for path attachments
// ---------------------------------------------------------------------------

/** Returns true for IPs that must not be fetched server-side. */
export function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.map(Number);
    const a = parts[1] ?? 0;
    const b = parts[2] ?? 0;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const norm = ip.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(norm)) return isPrivateIp(norm);
  return (
    norm === "::1" ||
    norm === "::" ||
    norm.startsWith("fe80:") ||
    norm.startsWith("fc") ||
    norm.startsWith("fd")
  );
}

async function fetchAttachmentFromPath(
  url: string,
  index: number,
): Promise<{ content: string; contentType: string | undefined }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ResendApiError(
      "invalid_attachment",
      `attachments[${index}].path is not a valid URL.`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new ResendApiError(
      "invalid_attachment",
      `attachments[${index}].path must use https://.`,
    );
  }

  // Resolve hostname and block private IPs before connecting.
  let lookupResults: { address: string; family: number }[];
  try {
    const rawLookup = await dns.lookup(parsed.hostname, { all: true });
    lookupResults = Array.isArray(rawLookup) ? rawLookup : [rawLookup as { address: string; family: number }];
  } catch {
    throw new ResendApiError(
      "invalid_attachment",
      `attachments[${index}].path hostname could not be resolved.`,
    );
  }
  for (const { address } of lookupResults) {
    if (isPrivateIp(address)) {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}].path resolves to a private or reserved IP address.`,
      );
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    ATTACHMENT_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}].path fetch returned HTTP ${response.status}.`,
      );
    }

    const contentType =
      response.headers.get("content-type") ?? undefined;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}].path returned an empty body.`,
      );
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_ATTACHMENTS_BYTES) {
        await reader.cancel();
        throw new ResendApiError(
          "invalid_attachment",
          `attachments[${index}].path exceeds the 40 MB size cap.`,
        );
      }
      chunks.push(value);
    }

    const content = Buffer.concat(chunks).toString("base64");
    return { content, contentType };
  } finally {
    clearTimeout(timer);
  }
}

async function toAttachments(
  attachments: ResendSendEmailInput["attachments"],
): Promise<EmailAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) return undefined;

  let totalBytes = 0;
  const results: EmailAttachment[] = [];

  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index]!;

    if (attachment.path !== undefined) {
      // Path attachment: fetch server-side with SSRF guard.
      const { content, contentType } = await fetchAttachmentFromPath(
        attachment.path,
        index,
      );
      const filename =
        attachment.filename ??
        attachment.path.split("/").pop() ??
        `attachment_${index}`;
      totalBytes += content.length;
      results.push({
        filename,
        content,
        ...(attachment.content_type ?? contentType
          ? { contentType: attachment.content_type ?? contentType }
          : {}),
        ...(attachment.content_id ? { cid: attachment.content_id } : {}),
      });
      continue;
    }

    if (attachment.content === undefined || attachment.content === "") {
      throw new ResendApiError(
        "invalid_attachment",
        `attachments[${index}] must include \`content\` or \`path\`.`,
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

    results.push({
      filename: attachment.filename,
      content,
      ...(attachment.content_type
        ? { contentType: attachment.content_type }
        : {}),
      ...(attachment.content_id ? { cid: attachment.content_id } : {}),
    });
  }

  if (totalBytes > MAX_ATTACHMENTS_BYTES) {
    throw new ResendApiError(
      "invalid_attachment",
      "Attachments exceed the 40 MB limit per email.",
    );
  }
  return results;
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
 *
 * `filterTopicRecipients` is called when `topic_id` is set; it removes
 * recipients opted out of the topic and returns the filtered arrays. Pass
 * `undefined` to reject `topic_id` with a "not supported" error.
 */
export async function toEmailContent(
  input: ResendSendEmailInput,
  resolveTemplateId: (idOrAlias: string) => Promise<string>,
  now?: Date,
  filterTopicRecipients?: (opts: {
    topicId: string;
    to: string[];
    cc: string[];
    bcc: string[];
  }) => Promise<{ to: string[]; cc: string[]; bcc: string[] }>,
): Promise<EmailContent & { topicId?: string }> {
  const nowDate = now ?? new Date();

  if (input.react !== undefined) {
    throw new ResendApiError(
      "validation_error",
      "`react` must be rendered to HTML before sending. The Resend SDK does this automatically when @react-email/render is installed.",
    );
  }
  if (input.topic_id !== undefined && filterTopicRecipients === undefined) {
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

  // Auto-generate plain text from HTML when text is absent.
  const text =
    input.text ??
    (input.html ? htmlToText(input.html, { wordwrap: 100 }) : undefined);

  let finalTo = to;
  let finalCc = toArray(input.cc);
  let finalBcc = toArray(input.bcc);

  if (input.topic_id && filterTopicRecipients) {
    const filtered = await filterTopicRecipients({
      topicId: input.topic_id,
      to: finalTo,
      cc: finalCc,
      bcc: finalBcc,
    });
    finalTo = filtered.to;
    finalCc = filtered.cc;
    finalBcc = filtered.bcc;
  }

  return {
    from: input.from,
    to: finalTo,
    subject: input.subject,
    ...(finalCc.length > 0 ? { cc: finalCc } : {}),
    ...(finalBcc.length > 0 ? { bcc: finalBcc } : {}),
    ...(input.reply_to !== undefined ? { replyTo: toArray(input.reply_to) } : {}),
    ...(input.html ? { html: input.html } : {}),
    ...(text ? { text } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.scheduled_at
      ? { scheduledAt: parseResendScheduledAt(input.scheduled_at, nowDate).toISOString() }
      : {}),
    ...(input.attachments
      ? { attachments: await toAttachments(input.attachments) }
      : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(input.topic_id ? { topicId: input.topic_id } : {}),
    ...(input.template
      ? {
          templateId: await resolveTemplateId(input.template.id),
          variables: toVariables(input.template.variables),
        }
      : {}),
  };
}
