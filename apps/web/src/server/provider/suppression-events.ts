import type { MailBounce, MailEvent } from "~/types/mail-events";
import type { ProviderSuppressionDetail } from "./types";

export type SuppressionEmailRef = {
  id: string;
  providerMessageId: string | null;
};

const MAILBOX_FULL_PATTERN =
  /mailbox (is )?full|over quota|quota exceeded|\b[45]\.2\.2\b/i;
const NO_EMAIL_PATTERN =
  /\b5\.1\.1\b|user unknown|no such user|does not exist|unknown recipient|recipient address rejected/i;
const TOO_LARGE_PATTERN = /too large|size limit|\b5\.3\.4\b/i;
const CONTENT_REJECTED_PATTERN = /\bspam\b|content rejected|policy|blocked/i;

export function classifyBounceSubType(
  errorDetail: string | undefined,
): MailBounce["bounceSubType"] {
  if (!errorDetail) return "General";
  if (MAILBOX_FULL_PATTERN.test(errorDetail)) return "MailboxFull";
  if (NO_EMAIL_PATTERN.test(errorDetail)) return "NoEmail";
  if (TOO_LARGE_PATTERN.test(errorDetail)) return "MessageTooLarge";
  if (CONTENT_REJECTED_PATTERN.test(errorDetail)) return "ContentRejected";
  return "General";
}

/**
 * Converts a provider suppression-list entry into a Scribase Mail event.
 * Returns null for entries that do not represent a delivery outcome
 * (manual, unsubscribe, unknown) or when no matching email exists.
 */
export function mapSuppressionToMailEvent(
  suppression: ProviderSuppressionDetail,
  email: SuppressionEmailRef | null,
): MailEvent | null {
  if (!email) {
    return null;
  }

  const timestamp = (
    suppression.lastSuppressedAt ?? suppression.createdAt
  ).toISOString();
  const mail = {
    timestamp,
    emailId: email.id,
    messageId: email.providerMessageId ?? suppression.messageId,
    destination: [suppression.email],
  };

  switch (suppression.reason) {
    case "HARD_BOUNCE":
    case "SOFT_BOUNCE": {
      const permanent = suppression.reason === "HARD_BOUNCE";
      return {
        eventType: "Bounce",
        mail,
        bounce: {
          bounceType: permanent ? "Permanent" : "Transient",
          bounceSubType: classifyBounceSubType(suppression.errorDetail),
          bouncedRecipients: [
            {
              emailAddress: suppression.email,
              action: "failed",
              status: permanent ? "5.0.0" : "4.0.0",
              diagnosticCode: suppression.errorDetail,
            },
          ],
          timestamp,
          feedbackId: suppression.id,
          reportingMTA: suppression.errorSource,
        },
      };
    }
    case "COMPLAINT":
      return {
        eventType: "Complaint",
        mail,
        complaint: {
          complainedRecipients: [{ emailAddress: suppression.email }],
          timestamp,
          feedbackId: suppression.id,
          complaintFeedbackType: "abuse",
        },
      };
    default:
      return null;
  }
}
