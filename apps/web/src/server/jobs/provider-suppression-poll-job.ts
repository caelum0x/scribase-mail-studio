import { Queue, Worker } from "bullmq";
import { env } from "~/env";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { getRedis, BULL_PREFIX } from "~/server/redis";
import {
  DEFAULT_QUEUE_OPTIONS,
  PROVIDER_SUPPRESSION_POLL_QUEUE,
} from "~/server/queue/queue-constants";
import { getEmailProvider } from "~/server/provider";
import type {
  EmailProvider,
  ProviderSuppressionDetail,
} from "~/server/provider/types";
import {
  mapSuppressionToMailEvent,
  type SuppressionEmailRef,
} from "~/server/provider/suppression-events";
import { processEmailEvent } from "~/server/service/email-event-service";
import type { MailEvent } from "~/types/mail-events";

/**
 * Bounces and complaints without push notifications:
 * the provider (OCI Email Delivery) adds hard bounces, soft bounces and
 * complaints to its suppression list. This job polls that list, maps each new
 * entry to a Bounce / Complaint event and feeds it through the normal event
 * pipeline (status update, team suppression list, metrics, webhooks).
 */

export const SUPPRESSION_CURSOR_KEY = "provider.suppression.cursor";
export const SUPPRESSION_POLL_OVERLAP_MS = 15 * 60 * 1000;
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const EMAIL_MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SENT_STATUSES = [
  "SENT",
  "DELIVERED",
  "DELIVERY_DELAYED",
  "OPENED",
  "CLICKED",
] as const;

export type PollResult = {
  seen: number;
  emitted: number;
  skipped: number;
  failed: number;
};

export type PollOptions = {
  provider?: EmailProvider;
  // eslint-disable-next-line no-unused-vars -- parameter name in type signature
  handleEvent?: (mailEvent: MailEvent) => Promise<unknown>;
  now?: Date;
};

async function readCursor(now: Date): Promise<Date> {
  const setting = await db.appSetting.findUnique({
    where: { key: SUPPRESSION_CURSOR_KEY },
  });
  const parsed = setting ? new Date(setting.value) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return parsed;
  }
  return new Date(now.getTime() - INITIAL_LOOKBACK_MS);
}

async function writeCursor(value: Date) {
  const iso = value.toISOString();
  await db.appSetting.upsert({
    where: { key: SUPPRESSION_CURSOR_KEY },
    create: { key: SUPPRESSION_CURSOR_KEY, value: iso },
    update: { value: iso },
  });
}

async function findEmailForSuppression(
  suppression: ProviderSuppressionDetail,
): Promise<SuppressionEmailRef | null> {
  if (suppression.messageId) {
    const byMessageId = await db.email.findUnique({
      where: { providerMessageId: suppression.messageId },
    });
    if (byMessageId) {
      return byMessageId;
    }
  }

  return db.email.findFirst({
    where: {
      to: { has: suppression.email },
      latestStatus: { in: [...SENT_STATUSES] },
      createdAt: {
        lte: suppression.createdAt,
        gte: new Date(suppression.createdAt.getTime() - EMAIL_MATCH_WINDOW_MS),
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

async function markProcessed(
  suppression: ProviderSuppressionDetail,
  emailId: string | null,
) {
  try {
    await db.processedProviderSuppression.create({
      data: {
        id: suppression.id,
        email: suppression.email,
        reason: suppression.reason,
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

export async function pollProviderSuppressions(
  options: PollOptions = {},
): Promise<PollResult> {
  const provider = options.provider ?? getEmailProvider();
  const handleEvent = options.handleEvent ?? processEmailEvent;
  const now = options.now ?? new Date();

  const cursor = await readCursor(now);
  const since = new Date(cursor.getTime() - SUPPRESSION_POLL_OVERLAP_MS);
  const summaries = await provider.listSuppressions(since);

  const result: PollResult = {
    seen: summaries.length,
    emitted: 0,
    skipped: 0,
    failed: 0,
  };

  if (summaries.length === 0) {
    return result;
  }

  const alreadyProcessed = await db.processedProviderSuppression.findMany({
    where: { id: { in: summaries.map((s) => s.id) } },
    select: { id: true },
  });
  const processedIds = new Set(alreadyProcessed.map((p) => p.id));

  for (const summary of summaries) {
    if (processedIds.has(summary.id)) {
      continue;
    }

    try {
      const suppression = await provider.getSuppression(summary.id);
      const email = await findEmailForSuppression(suppression);
      const event = mapSuppressionToMailEvent(suppression, email);

      if (event) {
        await handleEvent(event);
        result.emitted += 1;
      } else {
        result.skipped += 1;
      }

      await markProcessed(suppression, email?.id ?? null);
    } catch (error) {
      result.failed += 1;
      logger.error(
        { err: error, suppressionId: summary.id },
        "[SuppressionPollJob]: Failed to process provider suppression",
      );
    }
  }

  const newest = summaries.reduce(
    (max, s) => (s.createdAt > max ? s.createdAt : max),
    cursor,
  );
  await writeCursor(newest);

  logger.info({ ...result }, "[SuppressionPollJob]: Poll finished");
  return result;
}

let initialized = false;

export async function initProviderSuppressionPollJob() {
  if (initialized) {
    return;
  }

  const connection = getRedis();
  const queue = new Queue(PROVIDER_SUPPRESSION_POLL_QUEUE, {
    connection,
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  });

  const worker = new Worker(
    PROVIDER_SUPPRESSION_POLL_QUEUE,
    async () => {
      await pollProviderSuppressions();
    },
    {
      connection,
      concurrency: 1,
      prefix: BULL_PREFIX,
      skipVersionCheck: true,
    },
  );

  await queue.upsertJobScheduler(
    "provider-suppression-poll",
    { pattern: env.SUPPRESSION_POLL_CRON, tz: "UTC" },
    { opts: { ...DEFAULT_QUEUE_OPTIONS } },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "[SuppressionPollJob]: Job failed");
  });

  initialized = true;
}
