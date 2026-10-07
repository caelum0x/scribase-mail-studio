/**
 * API request log retention cleanup job.
 *
 * Runs daily (00:30 UTC) and deletes `ApiRequestLog` rows older than
 * `API_LOG_RETENTION_DAYS` (default: 30).
 *
 * Enabled in cloud mode; self-hosted instances can set
 * `API_LOG_RETENTION_DAYS=0` to disable retention enforcement.
 */
import { Queue, Worker } from "bullmq";
import { db } from "~/server/db";
import { getRedis, BULL_PREFIX } from "~/server/redis";
import { logger } from "../logger/log";
import { DEFAULT_QUEUE_OPTIONS } from "../queue/queue-constants";
import { getLogRetentionDays } from "../public-api/request-log-middleware";

const QUEUE_NAME = "api-log-cleanup";
const CLEANUP_CRON = "30 0 * * *"; // 00:30 UTC daily

const apiLogCleanupQueue = new Queue(QUEUE_NAME, {
  connection: getRedis(),
  prefix: BULL_PREFIX,
  skipVersionCheck: true,
});

const apiLogCleanupWorker = new Worker(
  QUEUE_NAME,
  async () => {
    const retentionDays = getLogRetentionDays();

    if (retentionDays === 0) {
      logger.info("[ApiLogCleanup] Retention disabled (API_LOG_RETENTION_DAYS=0); skipping.");
      return;
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    logger.info(
      { retentionDays, cutoff },
      "[ApiLogCleanup] Starting API request log cleanup",
    );

    const { count } = await db.apiRequestLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    logger.info({ deleted: count, retentionDays }, "[ApiLogCleanup] Cleanup complete");
  },
  {
    connection: getRedis(),
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
    removeOnComplete: { count: 10 },
    removeOnFail: DEFAULT_QUEUE_OPTIONS.removeOnFail,
  },
);

apiLogCleanupWorker.on("error", (err: unknown) => {
  logger.error({ err }, "[ApiLogCleanup] Worker error");
});

// Schedule the daily cron (upsert so restarts are idempotent).
void apiLogCleanupQueue
  .upsertJobScheduler(QUEUE_NAME, { pattern: CLEANUP_CRON }, {})
  .catch((err: unknown) => {
    logger.error({ err }, "[ApiLogCleanup] Failed to schedule cron");
  });

logger.info("[ApiLogCleanup] API log cleanup job registered");
