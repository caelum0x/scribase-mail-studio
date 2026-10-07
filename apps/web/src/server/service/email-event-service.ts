import {
  EmailStatus,
  SuppressionReason,
  UnsubscribeReason,
  type Email,
} from "@prisma/client";
import {
  type EmailBasePayload,
  type EmailEventPayloadMap,
  type EmailWebhookEventType,
} from "@usesend/lib/src/webhook/webhook-events";
import {
  MailBounce,
  MailClick,
  MailEvent,
  MailEventDataKey,
} from "~/types/mail-events";
import { db } from "../db";
import {
  unsubscribeContact,
  updateCampaignAnalytics,
} from "./campaign-service";
import { env } from "~/env";
import { getRedis, BULL_PREFIX } from "../redis";
import { Queue, Worker } from "bullmq";
import {
  DEFAULT_QUEUE_OPTIONS,
  EMAIL_EVENT_QUEUE,
} from "../queue/queue-constants";
import { getChildLogger, logger, withLogger } from "../logger/log";
import { randomUUID } from "crypto";
import { SuppressionService } from "./suppression-service";
import { WebhookService } from "./webhook-service";
import {
  NO_REPEAT,
  RECIPIENT_DEDUPED_STATUSES,
  evaluateRepeatEvent,
} from "./email-event-dedupe";

async function findEmailForEvent(data: MailEvent): Promise<Email | null> {
  if (data.mail.emailId) {
    const byId = await db.email.findUnique({
      where: { id: data.mail.emailId },
    });
    if (byId) {
      return byId;
    }
  }

  if (data.mail.messageId) {
    return db.email.findUnique({
      where: { providerMessageId: data.mail.messageId },
    });
  }

  return null;
}

export async function processEmailEvent(data: MailEvent) {
  const mailStatus = getEmailStatus(data);

  if (!mailStatus) {
    logger.error({ data }, "Unknown email status");
    return false;
  }

  const providerMessageId = data.mail.messageId;
  const emailId = data.mail.emailId;

  const mailData = getEmailData(data);

  logger.setBindings({
    providerMessageId,
    mailId: emailId,
  });

  logger.info({ mailStatus }, "Processing email event");

  const email = await findEmailForEvent(data);

  logger.setBindings({
    providerMessageId,
    mailId: email?.id,
    teamId: email?.teamId,
  });

  if (!email) {
    logger.error({ data }, "Email not found");
    return false;
  }

  if (
    email.latestStatus === mailStatus &&
    mailStatus === EmailStatus.DELIVERY_DELAYED
  ) {
    return true;
  }

  // Same outcome may arrive from the delivery logs and the suppression poll.
  const repeat = RECIPIENT_DEDUPED_STATUSES.includes(mailStatus)
    ? evaluateRepeatEvent(
        mailStatus,
        mailData,
        (
          await db.emailEvent.findMany({
            where: { emailId: email.id, status: mailStatus },
            select: { data: true },
          })
        ).map((event) => event.data),
      )
    : NO_REPEAT;

  if (repeat.skip) {
    logger.info({ mailStatus }, "Duplicate delivery outcome; skipping");
    return true;
  }

  const isEngagementEvent =
    mailStatus === EmailStatus.OPENED || mailStatus === EmailStatus.CLICKED;
  const existingMailEvent =
    email.campaignId || isEngagementEvent
      ? await db.emailEvent.findFirst({
          where: {
            emailId: email.id,
            status: mailStatus,
          },
        })
      : null;

  // Update the latest status and to avoid race conditions
  await db.$executeRaw`
      UPDATE "Email"
      SET "latestStatus" = CASE
        WHEN ${mailStatus}::text::\"EmailStatus\" > "latestStatus" OR "latestStatus" IS NULL OR "latestStatus" = 'SCHEDULED'::\"EmailStatus\"
        THEN ${mailStatus}::text::\"EmailStatus\"
        ELSE "latestStatus"
      END
      WHERE id = ${email.id}
    `;

  logger.info("Latest status updated");

  // Update daily email usage statistics
  const today = new Date().toISOString().split("T")[0] as string; // Format: YYYY-MM-DD

  const isHardBounced =
    mailStatus === EmailStatus.BOUNCED &&
    (mailData as MailBounce).bounceType === "Permanent";

  // Fix: Only add the actual bounced/complained recipients to suppression list
  // Add emails to suppression list for hard bounces and complaints
  if (isHardBounced || mailStatus === EmailStatus.COMPLAINED) {
    logger.info("Adding emails to suppression list");

    // Get the actual affected recipients from the event data
    let recipientEmails: string[] = [];

    if (isHardBounced && data.bounce?.bouncedRecipients) {
      // For bounces, only add the recipients that actually bounced
      recipientEmails = data.bounce.bouncedRecipients.map(
        (recipient) => recipient.emailAddress,
      );
    } else if (
      mailStatus === EmailStatus.COMPLAINED &&
      data.complaint?.complainedRecipients
    ) {
      // For complaints, only add the recipients that actually complained
      recipientEmails = data.complaint.complainedRecipients.map(
        (recipient) => recipient.emailAddress,
      );
    }

    // Only proceed if we have affected recipients
    if (recipientEmails.length > 0) {
      try {
        await Promise.all(
          recipientEmails.map((recipientEmail) =>
            SuppressionService.addSuppression({
              email: recipientEmail,
              teamId: email.teamId,
              reason: isHardBounced
                ? SuppressionReason.HARD_BOUNCE
                : SuppressionReason.COMPLAINT,
              source: email.id,
            }),
          ),
        );

        logger.info(
          {
            emailId: email.id,
            recipients: recipientEmails,
            reason: isHardBounced ? "HARD_BOUNCE" : "COMPLAINT",
          },
          "Added emails to suppression list due to bounce/complaint",
        );
      } catch (error) {
        logger.error(
          {
            emailId: email.id,
            recipients: recipientEmails,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Failed to add emails to suppression list",
        );
        // Don't throw error - continue processing the webhook
      }
    } else {
      logger.warn(
        {
          emailId: email.id,
          eventType: data.eventType,
        },
        "No affected recipients found in bounce/complaint event data",
      );
    }
  }

  const isDuplicateEngagement = Boolean(existingMailEvent) && isEngagementEvent;

  if (repeat.hardBounceUpgrade) {
    await recordHardBounceUpgrade(email, today);
  }

  if (
    !isDuplicateEngagement &&
    !repeat.repeat &&
    [
      "DELIVERED",
      "OPENED",
      "CLICKED",
      "BOUNCED",
      "COMPLAINED",
      "SENT",
    ].includes(mailStatus)
  ) {
    logger.info("Updating daily email usage");
    const updateField = mailStatus.toLowerCase();

    await db.dailyEmailUsage.upsert({
      where: {
        teamId_domainId_date_type: {
          teamId: email.teamId,
          domainId: email.domainId ?? 0,
          date: today,
          type: email.campaignId ? "MARKETING" : "TRANSACTIONAL",
        },
      },
      create: {
        teamId: email.teamId,
        domainId: email.domainId ?? 0,
        date: today,
        type: email.campaignId ? "MARKETING" : "TRANSACTIONAL",
        delivered: updateField === "delivered" ? 1 : 0,
        opened: updateField === "opened" ? 1 : 0,
        clicked: updateField === "clicked" ? 1 : 0,
        bounced: updateField === "bounced" ? 1 : 0,
        complained: updateField === "complained" ? 1 : 0,
        sent: updateField === "sent" ? 1 : 0,
        hardBounced: isHardBounced ? 1 : 0,
      },
      update: {
        [updateField]: {
          increment: 1,
        },
        ...(isHardBounced ? { hardBounced: { increment: 1 } } : {}),
      },
    });

    if (
      isHardBounced ||
      updateField === "complained" ||
      updateField === "delivered"
    ) {
      logger.info("Updating cumulated metrics");
      const cumulatedField = isHardBounced ? "hardBounced" : updateField;
      await db.cumulatedMetrics.upsert({
        where: {
          teamId_domainId: {
            teamId: email.teamId,
            domainId: email.domainId ?? 0,
          },
        },
        update: {
          [cumulatedField]: {
            increment: BigInt(1),
          },
        },
        create: {
          teamId: email.teamId,
          domainId: email.domainId ?? 0,
          [cumulatedField]: BigInt(1),
        },
      });
    }
  }

  if (email.campaignId) {
    if (
      mailStatus !== "CLICKED" ||
      !(mailData as MailClick).link.startsWith(
        `${env.NEXTAUTH_URL}/unsubscribe`,
      )
    ) {
      await checkUnsubscribe({
        contactId: email.contactId!,
        campaignId: email.campaignId,
        teamId: email.teamId,
        event: mailStatus,
        mailData: data,
      });

      if (!existingMailEvent) {
        await updateCampaignAnalytics(
          email.campaignId,
          mailStatus,
          isHardBounced,
        );
      }
    }
  }

  logger.info("Creating email event");

  await db.emailEvent.create({
    data: {
      emailId: email.id,
      status: mailStatus,
      data: mailData as any,
      teamId: email.teamId,
    },
  });

  logger.info("Email event created");

  try {
    const occurredAt = data.mail.timestamp
      ? new Date(data.mail.timestamp).toISOString()
      : new Date().toISOString();

    const metadata = buildEmailMetadata(mailStatus, mailData);

    await WebhookService.emit(
      email.teamId,
      emailStatusToEvent(mailStatus),
      buildEmailWebhookPayload({
        email,
        status: mailStatus,
        occurredAt,
        eventData: mailData,
        metadata,
      }),
      {
        domainId: email.domainId ?? null,
      },
    );
  } catch (error) {
    logger.error(
      { error, emailId: email.id, mailStatus },
      "[EmailEventService]: Failed to emit webhook",
    );
  }

  return true;
}

/**
 * A permanent bounce after a transient one for the same email: "bounced" was
 * already counted, only the hard-bounce counters are missing.
 */
async function recordHardBounceUpgrade(email: Email, today: string) {
  const domainId = email.domainId ?? 0;
  const type = email.campaignId ? "MARKETING" : "TRANSACTIONAL";
  await db.dailyEmailUsage.upsert({
    where: {
      teamId_domainId_date_type: {
        teamId: email.teamId,
        domainId,
        date: today,
        type,
      },
    },
    create: {
      teamId: email.teamId,
      domainId,
      date: today,
      type,
      hardBounced: 1,
    },
    update: { hardBounced: { increment: 1 } },
  });
  await db.cumulatedMetrics.upsert({
    where: { teamId_domainId: { teamId: email.teamId, domainId } },
    update: { hardBounced: { increment: BigInt(1) } },
    create: { teamId: email.teamId, domainId, hardBounced: BigInt(1) },
  });
}

type EmailBounceSubType =
  EmailEventPayloadMap["email.bounced"]["bounce"]["subType"];

function buildEmailWebhookPayload(params: {
  email: Email;
  status: EmailStatus;
  occurredAt: string;
  eventData: MailEvent | MailEvent[MailEventDataKey];
  metadata?: Record<string, unknown>;
}): EmailEventPayloadMap[EmailWebhookEventType] {
  const { email, status, eventData, occurredAt, metadata } = params;

  const basePayload: EmailBasePayload = {
    id: email.id,
    status,
    from: email.from,
    to: email.to,
    occurredAt,
    campaignId: email.campaignId ?? undefined,
    contactId: email.contactId ?? undefined,
    domainId: email.domainId ?? null,
    subject: email.subject,
    metadata,
  };

  switch (status) {
    case EmailStatus.BOUNCED: {
      const bounce = eventData as MailBounce | undefined;
      return {
        ...basePayload,
        bounce: {
          type: bounce?.bounceType ?? "Undetermined",
          subType: normalizeBounceSubType(bounce?.bounceSubType),
          message: bounce?.bouncedRecipients?.[0]?.diagnosticCode,
        },
      };
    }
    case EmailStatus.OPENED: {
      const openData = eventData as MailEvent["open"];
      return {
        ...basePayload,
        open: {
          timestamp: openData?.timestamp ?? occurredAt,
          userAgent: openData?.userAgent,
          ip: openData?.ipAddress,
        },
      };
    }
    case EmailStatus.CLICKED: {
      const clickData = eventData as MailClick | undefined;
      return {
        ...basePayload,
        click: {
          timestamp: clickData?.timestamp ?? occurredAt,
          url: clickData?.link ?? "",
          userAgent: clickData?.userAgent,
          ip: clickData?.ipAddress,
        },
      };
    }
    default:
      return basePayload;
  }
}

function normalizeBounceSubType(
  subType: MailBounce["bounceSubType"] | undefined,
): EmailBounceSubType {
  const normalized = subType?.replace(/\s+/g, "") as
    EmailBounceSubType | undefined;

  const validSubTypes: EmailBounceSubType[] = [
    "General",
    "NoEmail",
    "Suppressed",
    "OnAccountSuppressionList",
    "MailboxFull",
    "MessageTooLarge",
    "ContentRejected",
    "AttachmentRejected",
  ];

  if (normalized && validSubTypes.includes(normalized)) {
    return normalized;
  }

  return "General";
}

function emailStatusToEvent(status: EmailStatus): EmailWebhookEventType {
  switch (status) {
    case EmailStatus.QUEUED:
      return "email.queued";
    case EmailStatus.SENT:
      return "email.sent";
    case EmailStatus.DELIVERY_DELAYED:
      return "email.delivery_delayed";
    case EmailStatus.DELIVERED:
      return "email.delivered";
    case EmailStatus.BOUNCED:
      return "email.bounced";
    case EmailStatus.REJECTED:
      return "email.rejected";
    case EmailStatus.RENDERING_FAILURE:
      return "email.rendering_failure";
    case EmailStatus.COMPLAINED:
      return "email.complained";
    case EmailStatus.FAILED:
      return "email.failed";
    case EmailStatus.CANCELLED:
      return "email.cancelled";
    case EmailStatus.SUPPRESSED:
      return "email.suppressed";
    case EmailStatus.OPENED:
      return "email.opened";
    case EmailStatus.CLICKED:
      return "email.clicked";
    default:
      return "email.queued";
  }
}

function buildEmailMetadata(
  status: EmailStatus,
  mailData: MailEvent | MailEvent[MailEventDataKey],
) {
  switch (status) {
    case EmailStatus.BOUNCED: {
      const bounce = mailData as MailBounce;
      return {
        bounceType: bounce.bounceType,
        bounceSubType: bounce.bounceSubType,
        diagnosticCode: bounce.bouncedRecipients?.[0]?.diagnosticCode,
      };
    }
    case EmailStatus.COMPLAINED: {
      const complaintInfo = (mailData as any)?.complaint ?? mailData;
      return {
        feedbackType: complaintInfo?.complaintFeedbackType,
        userAgent: complaintInfo?.userAgent,
      };
    }
    case EmailStatus.OPENED: {
      const openData = (mailData as any)?.open ?? mailData;
      return {
        ipAddress: openData?.ipAddress,
        userAgent: openData?.userAgent,
      };
    }
    case EmailStatus.CLICKED: {
      const click = mailData as MailClick;
      return {
        ipAddress: click.ipAddress,
        userAgent: click.userAgent,
        link: click.link,
      };
    }
    case EmailStatus.RENDERING_FAILURE: {
      const failure = mailData as MailEvent["renderingFailure"];
      return {
        errorMessage: failure?.errorMessage,
        templateName: failure?.templateName,
      };
    }
    case EmailStatus.DELIVERY_DELAYED: {
      const deliveryDelay = mailData as MailEvent["deliveryDelay"];
      return {
        delayType: deliveryDelay?.delayType,
        expirationTime: deliveryDelay?.expirationTime,
        delayedRecipients: deliveryDelay?.delayedRecipients,
      };
    }
    case EmailStatus.REJECTED: {
      const reject = mailData as MailEvent["reject"];
      return {
        reason: reject?.reason,
      };
    }
    default:
      return undefined;
  }
}

async function checkUnsubscribe({
  contactId,
  campaignId,
  teamId,
  event,
  mailData,
}: {
  contactId: string;
  campaignId: string;
  teamId: number;
  event: EmailStatus;
  mailData: MailEvent;
}) {
  /**
   * If the email is bounced and the bounce type is permanent, we need to unsubscribe the contact
   * If the email is complained, we need to unsubscribe the contact
   */
  if (
    (event === EmailStatus.BOUNCED &&
      mailData.bounce?.bounceType === "Permanent") ||
    event === EmailStatus.COMPLAINED
  ) {
    const contact = await db.contact.findUnique({
      where: {
        id: contactId,
      },
    });

    if (!contact) {
      return;
    }

    const allContacts = await db.contact.findMany({
      where: {
        email: contact.email,
        contactBook: {
          teamId,
        },
      },
    });

    const allContactIds = allContacts
      .map((c) => c.id)
      .filter((c) => c !== contactId);

    await Promise.all([
      unsubscribeContact({
        contactId,
        campaignId,
        reason:
          event === EmailStatus.BOUNCED
            ? UnsubscribeReason.BOUNCED
            : UnsubscribeReason.COMPLAINED,
      }),
      ...allContactIds.map((c) =>
        unsubscribeContact({
          contactId: c,
          reason:
            event === EmailStatus.BOUNCED
              ? UnsubscribeReason.BOUNCED
              : UnsubscribeReason.COMPLAINED,
        }),
      ),
    ]);
  }
}

function getEmailStatus(data: MailEvent) {
  const { eventType } = data;

  if (eventType === "Send") {
    return EmailStatus.SENT;
  } else if (eventType === "Delivery") {
    return EmailStatus.DELIVERED;
  } else if (eventType === "Bounce") {
    return EmailStatus.BOUNCED;
  } else if (eventType === "Complaint") {
    return EmailStatus.COMPLAINED;
  } else if (eventType === "Reject") {
    return EmailStatus.REJECTED;
  } else if (eventType === "Open") {
    return EmailStatus.OPENED;
  } else if (eventType === "Click") {
    return EmailStatus.CLICKED;
  } else if (eventType === "Rendering Failure") {
    return EmailStatus.RENDERING_FAILURE;
  } else if (eventType === "DeliveryDelay") {
    return EmailStatus.DELIVERY_DELAYED;
  }
}

function getEmailData(data: MailEvent) {
  const { eventType } = data;

  if (eventType === "Rendering Failure") {
    return data.renderingFailure;
  } else if (eventType === "DeliveryDelay") {
    return data.deliveryDelay;
  } else {
    return data[eventType.toLowerCase() as MailEventDataKey];
  }
}

export class EmailEventQueue {
  private static eventQueue = new Queue(EMAIL_EVENT_QUEUE, {
    connection: getRedis(),
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  });

  private static worker = new Worker(
    EMAIL_EVENT_QUEUE,
    async (job) => {
      return await withLogger(
        getChildLogger({
          queueId: job.id ?? randomUUID(),
        }),
        async () => {
          await this.execute(job.data);
        },
      );
    },
    {
      connection: getRedis(),
      prefix: BULL_PREFIX,
      skipVersionCheck: true,
      concurrency: 50,
    },
  );

  private static async execute(event: MailEvent) {
    try {
      await processEmailEvent(event);
    } catch (error) {
      logger.error({ error }, "Error processing email event");
      throw error;
    }
  }

  static async queue(data: { event: MailEvent; messageId: string }) {
    return await this.eventQueue.add(
      data.messageId,
      data.event,
      DEFAULT_QUEUE_OPTIONS,
    );
  }
}
