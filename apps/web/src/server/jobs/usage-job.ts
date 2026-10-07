import { Queue, Worker } from "bullmq";
import { reportDailyUsage } from "~/server/billing/usage";
import { getRedis, BULL_PREFIX } from "~/server/redis";
import { DEFAULT_QUEUE_OPTIONS } from "../queue/queue-constants";
import { logger } from "../logger/log";

const USAGE_QUEUE_NAME = "usage-reporting";

const usageQueue = new Queue(USAGE_QUEUE_NAME, {
  connection: getRedis(),
  prefix: BULL_PREFIX,
  skipVersionCheck: true,
});

// Reports daily sent-email counts to the Dodo Payments usage meter.
// Event ids are per team per day, so re-runs and retries never double bill.
const worker = new Worker(
  USAGE_QUEUE_NAME,
  async () => {
    const result = await reportDailyUsage();
    if ("skipped" in result) {
      logger.info("[Usage Reporting]: Billing not configured, skipped");
    }
    return result;
  },
  {
    connection: getRedis(),
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  },
);

await usageQueue.upsertJobScheduler(
  "daily-usage-report",
  {
    pattern: "0 */12 * * *", // every 12 hours (00:00, 12:00 UTC)
    tz: "UTC",
  },
  {
    opts: {
      ...DEFAULT_QUEUE_OPTIONS,
    },
  },
);

worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, `[Usage Reporting] Job completed`);
});

worker.on("failed", (job, err) => {
  logger.error({ err, jobId: job?.id }, `[Usage Reporting] Job failed`);
});
