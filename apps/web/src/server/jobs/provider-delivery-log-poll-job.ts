import { Queue, Worker } from "bullmq";
import { DomainStatus } from "@prisma/client";
import { env } from "~/env";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { getRedis, BULL_PREFIX } from "~/server/redis";
import {
  DEFAULT_QUEUE_OPTIONS,
  PROVIDER_DELIVERY_LOG_POLL_QUEUE,
} from "~/server/queue/queue-constants";
import { getEmailProvider } from "~/server/provider";
import type {
  EmailProvider,
  ProviderDeliveryEvent,
} from "~/server/provider/types";
import { DeliveryLogsNotConfiguredError } from "~/server/provider/oci/delivery-logs";
import { ProviderNotConfiguredError } from "~/server/provider/oci/oci-provider";
import {
  mapDeliveryLogToMailEvent,
  type DeliveryEmailRef,
} from "~/server/provider/delivery-events";
import { processEmailEvent } from "~/server/service/email-event-service";
import type { MailEvent } from "~/types/mail-events";

/**
 * Near-real-time delivered / bounced / complained events (Resend parity):
 * OCI Email Delivery writes one "OutboundRelayed" log record per recipient
 * (relay, bounce, complaint, ...). This job reads them every minute through
 * the OCI Logging Search API, maps each record to a Delivery / Bounce /
 * Complaint event and feeds it through the normal event pipeline (status,
 * usage counters, team suppression list, metrics, webhooks).
 *
 * The suppression-list poll stays as a fallback; processEmailEvent skips a
 * bounce/complaint already recorded for the same recipient.
 */

export const DELIVERY_LOG_CURSOR_KEY = "provider.deliveryLog.cursor";
/** Log records can be indexed a few minutes after they happen. */
export const DELIVERY_LOG_POLL_OVERLAP_MS = 10 * 60 * 1000;
export const DELIVERY_LOG_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const PROCESSED_LOG_EVENT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
/** Back-off after a failed ensure (e.g. missing IAM policy) per domain. */
export const ENSURE_LOGS_RETRY_MS = 30 * 60 * 1000;
const HANDLED_ACTIONS = new Set(["relay", "bounce", "complaint"]);
const ensureRetryAt = new Map<number, number>();

export type DeliveryPollResult = {
  seen: number;
  emitted: number;
  skipped: number;
  failed: number;
};

export type DeliveryPollOptions = {
  provider?: EmailProvider;
  // eslint-disable-next-line no-unused-vars -- parameter name in type signature
  handleEvent?: (mailEvent: MailEvent) => Promise<unknown>;
  now?: Date;
};

function isNotConfigured(error: unknown) {
  return (
    error instanceof DeliveryLogsNotConfiguredError ||
    error instanceof ProviderNotConfiguredError
  );
}

async function readCursor(now: Date): Promise<Date> {
  const setting = await db.appSetting.findUnique({
    where: { key: DELIVERY_LOG_CURSOR_KEY },
  });
  const parsed = setting ? new Date(setting.value) : null;
  const floor = new Date(now.getTime() - DELIVERY_LOG_MAX_LOOKBACK_MS);
  if (parsed && !Number.isNaN(parsed.getTime()) && parsed > floor) {
    return parsed;
  }
  return floor;
}

async function writeCursor(value: Date) {
  const iso = value.toISOString();
  await db.appSetting.upsert({
    where: { key: DELIVERY_LOG_CURSOR_KEY },
    create: { key: DELIVERY_LOG_CURSOR_KEY, value: iso },
    update: { value: iso },
  });
}

/**
 * Enables the delivery logs on every verified domain. The provider caches
 * successful calls, so this is cheap on every poll and also covers domains
 * created before delivery logs existed.
 */
export async function ensureDeliveryLogsForDomains(
  provider: EmailProvider,
  now: Date = new Date(),
) {
  const domains = await db.domain.findMany({
    where: { status: DomainStatus.SUCCESS },
    select: {
      id: true,
      name: true,
      providerDomainId: true,
      dkimId: true,
      dkimSelector: true,
    },
  });

  for (const domain of domains) {
    if ((ensureRetryAt.get(domain.id) ?? 0) > now.getTime()) {
      continue;
    }
    try {
      await provider.ensureDeliveryLogs(domain);
      ensureRetryAt.delete(domain.id);
    } catch (error) {
      if (isNotConfigured(error)) return;
      ensureRetryAt.set(domain.id, now.getTime() + ENSURE_LOGS_RETRY_MS);
      logger.warn(
        { err: error, domainId: domain.id },
        "[DeliveryLogPollJob]: Could not enable delivery logs for domain",
      );
    }
  }
}

async function findEmails(events: ProviderDeliveryEvent[]) {
  const messageIds = [
    ...new Set(
      events.map((e) => e.messageId).filter((id): id is string => !!id),
    ),
  ];
  if (messageIds.length === 0) {
    return new Map<string, DeliveryEmailRef>();
  }

  const emails = await db.email.findMany({
    where: { providerMessageId: { in: messageIds } },
    select: { id: true, providerMessageId: true },
  });
  return new Map(
    emails.map((email) => [email.providerMessageId as string, email]),
  );
}

async function markProcessed(
  event: ProviderDeliveryEvent,
  emailId: string | null,
) {
  try {
    await db.processedProviderLogEvent.create({
      data: {
        id: event.id,
        action: event.action,
        messageId: event.messageId ?? null,
        recipient: event.recipient ?? null,
        emailId,
      },
    });
  } catch (error) {
    // Unique violation = another worker already recorded it.
    if ((error as { code?: string })?.code !== "P2002") {
      throw error;
    }
  }
}

async function pruneProcessed(now: Date) {
  await db.processedProviderLogEvent.deleteMany({
    where: {
      createdAt: {
        lt: new Date(now.getTime() - PROCESSED_LOG_EVENT_RETENTION_MS),
      },
    },
  });
}

export async function pollProviderDeliveryLogs(
  options: DeliveryPollOptions = {},
): Promise<DeliveryPollResult> {
  const provider = options.provider ?? getEmailProvider();
  const handleEvent = options.handleEvent ?? processEmailEvent;
  const now = options.now ?? new Date();
  const result: DeliveryPollResult = {
    seen: 0,
    emitted: 0,
    skipped: 0,
    failed: 0,
  };

  await ensureDeliveryLogsForDomains(provider, now);

  const cursor = await readCursor(now);
  const since = new Date(cursor.getTime() - DELIVERY_LOG_POLL_OVERLAP_MS);

  let page;
  try {
    page = await provider.listDeliveryEvents(since, now);
  } catch (error) {
    if (isNotConfigured(error)) {
      logger.debug("[DeliveryLogPollJob]: OCI API not configured; skipping");
      return result;
    }
    throw error;
  }

  const events = page.events.filter((e) => HANDLED_ACTIONS.has(e.action));
  result.seen = events.length;

  const alreadyProcessed = events.length
    ? await db.processedProviderLogEvent.findMany({
        where: { id: { in: events.map((e) => e.id) } },
        select: { id: true },
      })
    : [];
  const processedIds = new Set(alreadyProcessed.map((p) => p.id));
  const pending = events.filter((e) => !processedIds.has(e.id));
  const emailsByMessageId = await findEmails(pending);

  for (const event of pending) {
    try {
      const email = event.messageId
        ? (emailsByMessageId.get(event.messageId) ?? null)
        : null;
      // No email = not sent by this install (shared tenancy) or not ours.
      const mailEvent = mapDeliveryLogToMailEvent(event, email);

      if (mailEvent) {
        await handleEvent(mailEvent);
        result.emitted += 1;
      } else {
        result.skipped += 1;
      }

      await markProcessed(event, email?.id ?? null);
    } catch (error) {
      result.failed += 1;
      logger.error(
        { err: error, logEventId: event.id, action: event.action },
        "[DeliveryLogPollJob]: Failed to process delivery log record",
      );
    }
  }

  // When the search was truncated resume from the last record we saw.
  const lastEvent = page.events[page.events.length - 1];
  const nextCursor = page.truncated && lastEvent ? lastEvent.timestamp : now;
  await writeCursor(nextCursor > cursor ? nextCursor : cursor);

  try {
    await pruneProcessed(now);
  } catch (error) {
    logger.warn(
      { err: error },
      "[DeliveryLogPollJob]: Failed to prune processed log events",
    );
  }

  if (result.seen > 0) {
    logger.info({ ...result }, "[DeliveryLogPollJob]: Poll finished");
  }
  return result;
}

/** Test hook: forget ensure back-offs. */
export function resetDeliveryLogEnsureBackoff() {
  ensureRetryAt.clear();
}

let initialized = false;

export async function initProviderDeliveryLogPollJob() {
  if (initialized) {
    return;
  }

  const connection = getRedis();
  const queue = new Queue(PROVIDER_DELIVERY_LOG_POLL_QUEUE, {
    connection,
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  });

  const worker = new Worker(
    PROVIDER_DELIVERY_LOG_POLL_QUEUE,
    async () => {
      await pollProviderDeliveryLogs();
    },
    {
      connection,
      concurrency: 1,
      prefix: BULL_PREFIX,
      skipVersionCheck: true,
    },
  );

  await queue.upsertJobScheduler(
    "provider-delivery-log-poll",
    { pattern: env.DELIVERY_LOG_POLL_CRON, tz: "UTC" },
    { opts: { ...DEFAULT_QUEUE_OPTIONS } },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "[DeliveryLogPollJob]: Job failed");
  });

  initialized = true;
}
