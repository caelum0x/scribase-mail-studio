import type { MailBounce, MailEvent } from "~/types/mail-events";
import { classifyBounceSubType } from "./suppression-events";
import type { ProviderDeliveryEvent } from "./types";

export type DeliveryEmailRef = {
  id: string;
  providerMessageId: string | null;
};

/** OCI bounceCategory values with a direct Scribase Mail sub type. */
const BOUNCE_CATEGORY_SUB_TYPES: Record<string, MailBounce["bounceSubType"]> = {
  "bad-mailbox": "NoEmail",
  "inactive-mailbox": "NoEmail",
  "bad-domain": "NoEmail",
  "quota-issues": "MailboxFull",
  "content-related": "ContentRejected",
  "spam-related": "ContentRejected",
  "virus-related": "AttachmentRejected",
  "policy-related": "ContentRejected",
};

const IP_IN_PARENS = /\(([0-9a-f.:]+)\)\s*$/i;

function bounceSubType(
  event: ProviderDeliveryEvent,
): MailBounce["bounceSubType"] {
  const byCategory = event.bounceCategory
    ? BOUNCE_CATEGORY_SUB_TYPES[event.bounceCategory.toLowerCase()]
    : undefined;
  return byCategory ?? classifyBounceSubType(event.smtpStatus ?? event.message);
}

function bounceType(event: ProviderDeliveryEvent): MailBounce["bounceType"] {
  if (event.bounceType === "hard") return "Permanent";
  if (event.bounceType === "soft") return "Transient";
  return "Undetermined";
}

function defaultStatusCode(type: MailBounce["bounceType"]) {
  if (type === "Permanent") return "5.0.0";
  if (type === "Transient") return "4.0.0";
  return "";
}

/**
 * Converts an Email Delivery log record (OutboundRelayed) into a Scribase
 * Mail event: relay -> Delivery, bounce -> Bounce, complaint -> Complaint.
 * Opens and clicks are tracked by Scribase Mail itself and unsubscribes go
 * through our own List-Unsubscribe endpoint, so those records return null,
 * as do records without a matching email or recipient.
 */
export function mapDeliveryLogToMailEvent(
  event: ProviderDeliveryEvent,
  email: DeliveryEmailRef | null,
): MailEvent | null {
  if (!email || !event.recipient) {
    return null;
  }

  const timestamp = event.timestamp.toISOString();
  const mail = {
    timestamp,
    emailId: email.id,
    messageId: email.providerMessageId ?? event.messageId,
    source: event.sender,
    destination: [event.recipient],
  };

  switch (event.action) {
    case "relay":
      return {
        eventType: "Delivery",
        mail,
        delivery: {
          timestamp,
          processingTimeMillis: event.processingTimeMs ?? 0,
          recipients: [event.recipient],
          smtpResponse: event.smtpStatus ?? "",
          reportingMTA: event.recipientMailServer ?? "",
          remoteMtaIp: event.recipientMailServer?.match(IP_IN_PARENS)?.[1],
        },
      };
    case "bounce": {
      const type = bounceType(event);
      return {
        eventType: "Bounce",
        mail,
        bounce: {
          bounceType: type,
          bounceSubType: bounceSubType(event),
          bouncedRecipients: [
            {
              emailAddress: event.recipient,
              action: "failed",
              status: event.bounceCode ?? defaultStatusCode(type),
              diagnosticCode: event.smtpStatus ?? event.message,
            },
          ],
          timestamp,
          feedbackId: event.id,
          reportingMTA: event.recipientMailServer,
        },
      };
    }
    case "complaint":
      return {
        eventType: "Complaint",
        mail,
        complaint: {
          complainedRecipients: [{ emailAddress: event.recipient }],
          timestamp,
          feedbackId: event.id,
          complaintFeedbackType: "abuse",
          arrivedDate: event.reportGeneratedTime?.toISOString(),
        },
      };
    default:
      return null;
  }
}
