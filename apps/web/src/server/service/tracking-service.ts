import { getTrackingSecret } from "~/server/utils/tracking-secret";
import { logger } from "~/server/logger/log";
import {
  isSafeRedirectUrl,
  verifyClickSignature,
  verifyOpenSignature,
} from "~/server/utils/email-tracking";
import type { MailEvent } from "~/types/mail-events";
import { EmailEventQueue } from "./email-event-service";

export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

type RequestMeta = { ip: string; userAgent: string };

export function getRequestMeta(req: Request): RequestMeta {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  return {
    ip: forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "",
    userAgent: req.headers.get("user-agent") ?? "",
  };
}

export async function recordOpen(
  emailId: string,
  signature: string | null,
  meta: RequestMeta,
) {
  if (!verifyOpenSignature(emailId, signature, getTrackingSecret())) {
    return false;
  }

  const timestamp = new Date().toISOString();
  const event: MailEvent = {
    eventType: "Open",
    mail: { timestamp, emailId },
    open: { timestamp, ipAddress: meta.ip, userAgent: meta.userAgent },
  };

  try {
    await EmailEventQueue.queue({
      event,
      messageId: `${emailId}-open-${Date.now()}`,
    });
  } catch (error) {
    logger.error({ err: error, emailId }, "[Tracking]: Failed to queue open");
  }
  return true;
}

/** Returns the destination URL when the click is valid, otherwise null. */
export async function recordClick(
  emailId: string,
  destination: string | null,
  signature: string | null,
  meta: RequestMeta,
): Promise<string | null> {
  if (
    !destination ||
    !isSafeRedirectUrl(destination) ||
    !verifyClickSignature(emailId, destination, signature, getTrackingSecret())
  ) {
    return null;
  }

  const timestamp = new Date().toISOString();
  const event: MailEvent = {
    eventType: "Click",
    mail: { timestamp, emailId },
    click: {
      timestamp,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      link: destination,
    },
  };

  try {
    await EmailEventQueue.queue({
      event,
      messageId: `${emailId}-click-${Date.now()}`,
    });
  } catch (error) {
    logger.error({ err: error, emailId }, "[Tracking]: Failed to queue click");
  }
  return destination;
}
