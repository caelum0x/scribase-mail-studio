/**
 * Maps our internal webhook payloads to the Resend-shaped wire format:
 *   { type, created_at, data: { email_id, from, to, subject, created_at, tags, ... } }
 *
 * Used when a webhook's signatureFormat === SVIX (Resend-compatible mode).
 * The internal call is stored with our own field names; this module
 * translates them before signing and dispatching.
 */
import type {
  EmailBasePayload,
  EmailBouncedPayload,
  EmailClickedPayload,
  EmailFailedPayload,
  EmailOpenedPayload,
  EmailSuppressedPayload,
  SuppressionPayload,
} from "@usesend/lib/src/webhook/webhook-events";

/** The Resend-shaped top-level envelope for any event. */
export type ResendWebhookEnvelope = {
  type: string;
  created_at: string;
  data: Record<string, unknown>;
};

/** Minimal shape the caller must supply to map an email event. */
type InternalEmailPayload = EmailBasePayload;

function toResendEmailData(
  payload: InternalEmailPayload,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    email_id: payload.id,
    from: payload.from,
    to: payload.to,
    subject: payload.subject ?? null,
    created_at: payload.occurredAt,
    message_id: null, // populated server-side from providerMessageId when available
    template_id: payload.templateId ?? null,
  };

  // Tags stored as array of { name, value } in our system; Resend uses Record<string,string>
  const tags = (payload as unknown as { tags?: Array<{ name: string; value: string }> }).tags;
  if (tags && Array.isArray(tags)) {
    const tagRecord: Record<string, string> = {};
    for (const t of tags) {
      tagRecord[t.name] = t.value;
    }
    base.tags = tagRecord;
  }

  return base;
}

/**
 * Maps an internal webhook payload (stored in WebhookCall.payload as JSON) to
 * the Resend-shaped envelope that is signed and delivered for SVIX webhooks.
 *
 * Returns the original payload unchanged for event types we do not know how
 * to map (safe fallback — we still deliver the call).
 */
export function toResendPayload(
  type: string,
  internalData: unknown,
  createdAt: string,
): ResendWebhookEnvelope {
  const data = internalData as Record<string, unknown>;

  switch (type) {
    case "email.sent":
    case "email.delivered":
    case "email.delivery_delayed":
    case "email.complained":
    case "email.cancelled":
    case "email.rejected":
    case "email.rendering_failure":
    case "email.queued":
    case "email.scheduled": {
      const payload = internalData as InternalEmailPayload;
      const resendData = toResendEmailData(payload);
      return { type, created_at: createdAt, data: resendData };
    }

    case "email.failed": {
      const fp = internalData as EmailFailedPayload;
      const resendData = toResendEmailData(fp);
      resendData.reason = fp.failed?.reason ?? "Unknown";
      return { type, created_at: createdAt, data: resendData };
    }

    case "email.suppressed": {
      const sp = internalData as EmailSuppressedPayload;
      const resendData = toResendEmailData(sp);
      resendData.suppression = {
        type: sp.suppression?.type ?? "Manual",
        reason: sp.suppression?.reason ?? "",
        source: sp.suppression?.source ?? null,
      };
      return { type, created_at: createdAt, data: resendData };
    }

    case "email.opened": {
      const op = internalData as EmailOpenedPayload;
      const resendData = toResendEmailData(op);
      resendData.timestamp = op.open?.timestamp ?? createdAt;
      resendData.user_agent = op.open?.userAgent ?? null;
      resendData.ip_address = op.open?.ip ?? null;
      return { type, created_at: createdAt, data: resendData };
    }

    case "email.clicked": {
      const cp = internalData as EmailClickedPayload;
      const resendData = toResendEmailData(cp);
      resendData.timestamp = cp.click?.timestamp ?? createdAt;
      resendData.url = cp.click?.url ?? null;
      resendData.user_agent = cp.click?.userAgent ?? null;
      resendData.ip_address = cp.click?.ip ?? null;
      return { type, created_at: createdAt, data: resendData };
    }

    case "email.bounced": {
      const bp = internalData as EmailBouncedPayload;
      const resendData = toResendEmailData(bp);
      resendData.bounce = {
        message: bp.bounce?.message ?? "",
        subType: bp.bounce?.subType ?? "General",
        type: bp.bounce?.type ?? "Permanent",
      };
      return { type, created_at: createdAt, data: resendData };
    }

    case "suppression.added":
    case "suppression.removed": {
      const sp = internalData as SuppressionPayload;
      return {
        type,
        created_at: createdAt,
        data: {
          id: sp.id,
          email: sp.email,
          origin:
            sp.reason === "Bounce"
              ? "bounce"
              : sp.reason === "Complaint"
                ? "complaint"
                : "manual",
          source_id: sp.source ?? null,
          created_at: sp.createdAt,
        },
      };
    }

    case "contact.created":
    case "contact.updated":
    case "contact.deleted":
    case "domain.created":
    case "domain.verified":
    case "domain.updated":
    case "domain.deleted":
      // For domain/contact events, snake_case the field names to match Resend conventions
      return {
        type,
        created_at: createdAt,
        data: snakeCaseShallow(data),
      };

    default:
      // Unknown event — deliver as-is with our internal shape
      return { type, created_at: createdAt, data };
  }
}

/** Shallow-converts camelCase object keys to snake_case. */
function snakeCaseShallow(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    result[snakeKey] = value;
  }
  return result;
}
