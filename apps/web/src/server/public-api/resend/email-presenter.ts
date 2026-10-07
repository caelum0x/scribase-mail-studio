import type { EmailStatus, Prisma } from "@prisma/client";
import type { EmailTag } from "~/types";

/** Resend `last_event` values. */
export type ResendLastEvent =
  | "bounced"
  | "canceled"
  | "clicked"
  | "complained"
  | "delivered"
  | "delivery_delayed"
  | "failed"
  | "opened"
  | "queued"
  | "scheduled"
  | "sent"
  | "suppressed";

const LAST_EVENT: Record<EmailStatus, ResendLastEvent> = {
  SCHEDULED: "scheduled",
  QUEUED: "queued",
  // Waiting for content/first-sends review; Resend has no equivalent event.
  HELD: "queued",
  SENT: "sent",
  DELIVERY_DELAYED: "delivery_delayed",
  BOUNCED: "bounced",
  REJECTED: "failed",
  RENDERING_FAILURE: "failed",
  DELIVERED: "delivered",
  OPENED: "opened",
  CLICKED: "clicked",
  COMPLAINED: "complained",
  FAILED: "failed",
  CANCELLED: "canceled",
  SUPPRESSED: "suppressed",
};

export function toLastEvent(status: EmailStatus): ResendLastEvent {
  return LAST_EVENT[status];
}

/** Columns needed to render a Resend email object. */
export const resendEmailSelect = {
  id: true,
  from: true,
  to: true,
  cc: true,
  bcc: true,
  replyTo: true,
  subject: true,
  html: true,
  text: true,
  latestStatus: true,
  scheduledAt: true,
  createdAt: true,
  providerMessageId: true,
  tags: true,
  topicId: true,
} satisfies Prisma.EmailSelect;

export type ResendEmailRow = Prisma.EmailGetPayload<{
  select: typeof resendEmailSelect;
}>;

export type ResendEmail = {
  object: "email";
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  subject: string;
  html: string | null;
  text: string | null;
  created_at: string;
  scheduled_at: string | null;
  last_event: ResendLastEvent;
  message_id: string | null;
  tags: EmailTag[];
  topic_id: string | null;
};

const nullIfEmpty = (values: string[]): string[] | null =>
  values.length > 0 ? values : null;

function toTags(value: Prisma.JsonValue | null): EmailTag[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof item.name === "string" &&
      typeof item.value === "string"
    ) {
      return [{ name: item.name, value: item.value }];
    }
    return [];
  });
}

export function toResendEmail(row: ResendEmailRow): ResendEmail {
  return {
    object: "email",
    id: row.id,
    from: row.from,
    to: row.to,
    cc: nullIfEmpty(row.cc),
    bcc: nullIfEmpty(row.bcc),
    reply_to: nullIfEmpty(row.replyTo),
    subject: row.subject,
    html: row.html,
    text: row.text,
    created_at: row.createdAt.toISOString(),
    scheduled_at: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    last_event: toLastEvent(row.latestStatus),
    message_id: row.providerMessageId,
    tags: toTags(row.tags),
    topic_id: row.topicId,
  };
}

/** List items omit the bodies, like Resend's GET /emails. */
export function toResendEmailListItem(
  row: ResendEmailRow,
): Omit<ResendEmail, "html" | "text"> {
  const { html: _html, text: _text, ...rest } = toResendEmail(row);
  return rest;
}
