import { EmailStatus } from "@prisma/client";

/**
 * Delivery outcomes can reach us from two sources (Email Delivery logs and
 * the provider suppression-list poll). These helpers decide whether an
 * incoming Delivery / Bounce / Complaint was already recorded for the same
 * recipient so status, usage counters and webhooks are not double counted.
 */

export const RECIPIENT_DEDUPED_STATUSES: EmailStatus[] = [
  EmailStatus.DELIVERED,
  EmailStatus.BOUNCED,
  EmailStatus.COMPLAINED,
];

export type RepeatDecision = {
  /** Every recipient in this event was already recorded: drop it. */
  skip: boolean;
  /** The email already has an event with this status: don't recount usage. */
  repeat: boolean;
  /** First permanent bounce after only transient ones: count hardBounced. */
  hardBounceUpgrade: boolean;
};

export const NO_REPEAT: RepeatDecision = {
  skip: false,
  repeat: false,
  hardBounceUpgrade: false,
};

type EventData = {
  bounceType?: unknown;
  bouncedRecipients?: Array<{ emailAddress?: unknown }>;
  complainedRecipients?: Array<{ emailAddress?: unknown }>;
  recipients?: unknown[];
};

function normalize(list: unknown[] | undefined): string[] | null {
  if (!Array.isArray(list)) return null;
  const emails = list
    .map((value) =>
      typeof value === "string"
        ? value
        : (value as { emailAddress?: unknown })?.emailAddress,
    )
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  return emails.length > 0 ? emails : null;
}

/** Recipients an event applies to; null when the event carries none. */
export function eventRecipients(
  status: EmailStatus,
  data: unknown,
): string[] | null {
  const event = (data ?? {}) as EventData;
  switch (status) {
    case EmailStatus.BOUNCED:
      return normalize(event.bouncedRecipients);
    case EmailStatus.COMPLAINED:
      return normalize(event.complainedRecipients);
    case EmailStatus.DELIVERED:
      return normalize(event.recipients);
    default:
      return null;
  }
}

function isPermanent(data: unknown) {
  return (data as EventData | null)?.bounceType === "Permanent";
}

export function evaluateRepeatEvent(
  status: EmailStatus,
  data: unknown,
  priorEvents: unknown[],
): RepeatDecision {
  if (priorEvents.length === 0) {
    return NO_REPEAT;
  }

  const permanent = status === EmailStatus.BOUNCED && isPermanent(data);
  // A transient bounce does not cover a later permanent one.
  const relevant = permanent ? priorEvents.filter(isPermanent) : priorEvents;
  const recipients = eventRecipients(status, data);

  let skip: boolean;
  if (!recipients) {
    skip = relevant.length > 0;
  } else {
    const covered = new Set<string>();
    let coversAll = false;
    for (const prior of relevant) {
      const priorRecipients = eventRecipients(status, prior);
      if (!priorRecipients) coversAll = true;
      priorRecipients?.forEach((r) => covered.add(r));
    }
    skip = coversAll || recipients.every((r) => covered.has(r));
  }

  return {
    skip,
    repeat: true,
    hardBounceUpgrade: !skip && permanent && relevant.length === 0,
  };
}
