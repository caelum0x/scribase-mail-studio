import { Queue, Worker } from "bullmq";
import { env } from "~/env";
import { logger } from "~/server/logger/log";
import { getRedis, BULL_PREFIX } from "~/server/redis";
import {
  DEFAULT_QUEUE_OPTIONS,
  THREAT_FEED_QUEUE,
} from "~/server/queue/queue-constants";
import {
  getThreatFeedMeta,
  parseListEnv,
  refreshThreatFeeds,
} from "~/server/screening/threat-feed-store";

let initialized = false;

/**
 * Refreshes the threat-feed host index used by content screening on a
 * schedule, and once at startup when no index exists yet.
 */
export async function initThreatFeedJob() {
  if (initialized) {
    return;
  }

  const urls = parseListEnv(env.SCREENING_FEED_URLS);
  if (!env.CONTENT_SCREENING_ENABLED || urls.length === 0) {
    logger.info("[ThreatFeedJob]: Disabled (screening off or no feed URLs)");
    initialized = true;
    return;
  }

  const connection = getRedis();
  const queue = new Queue(THREAT_FEED_QUEUE, {
    connection,
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  });

  const worker = new Worker(
    THREAT_FEED_QUEUE,
    async () => {
      const { saved, meta } = await refreshThreatFeeds({ urls });
      logger.info(
        { saved, hosts: meta.hosts, sources: meta.sources },
        "[ThreatFeedJob]: Run finished",
      );
    },
    {
      connection,
      concurrency: 1,
      prefix: BULL_PREFIX,
      skipVersionCheck: true,
    },
  );

  await queue.upsertJobScheduler(
    "threat-feed-refresh",
    { pattern: env.SCREENING_FEED_CRON, tz: "UTC" },
    { opts: { ...DEFAULT_QUEUE_OPTIONS } },
  );

  if (!(await getThreatFeedMeta())) {
    await queue.add(
      "threat-feed-initial",
      {},
      { ...DEFAULT_QUEUE_OPTIONS, jobId: "threat-feed-initial" },
    );
  }

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "[ThreatFeedJob]: Job failed");
  });

  initialized = true;
}
