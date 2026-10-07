import { initDomainVerificationJob } from "~/server/jobs/domain-verification-job";
import { isCloud, isEmailCleanupEnabled } from "~/utils/common";

let initialized = false;

/**
 * Add things here to be executed during server startup.
 *
 * more details here: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.NEXT_RUNTIME === "nodejs" && !initialized) {
    console.log("Registering instrumentation");

    const { EmailQueueService } =
      await import("~/server/service/email-queue-service");
    await EmailQueueService.init();

    /**
     * Report usage to the Dodo Payments meter
     */
    if (isCloud()) {
      await import("~/server/jobs/usage-job");
    }

    if (process.env.REDIS_URL) {
      await initDomainVerificationJob();

      const { initProviderSuppressionPollJob } =
        await import("~/server/jobs/provider-suppression-poll-job");
      await initProviderSuppressionPollJob();

      // Delivered / bounced / complained from the Email Delivery logs.
      const { initProviderDeliveryLogPollJob } =
        await import("~/server/jobs/provider-delivery-log-poll-job");
      await initProviderDeliveryLogPollJob();

      // Shared-tenancy abuse control; only multi-tenant (cloud) installs need it.
      if (isCloud()) {
        const { initReputationGuardJob } =
          await import("~/server/jobs/reputation-guard-job");
        await initReputationGuardJob();
      }

      // Threat feeds for content screening (any mode; off via env).
      const { initThreatFeedJob } =
        await import("~/server/jobs/threat-feed-job");
      await initThreatFeedJob();
    }

    if (isEmailCleanupEnabled()) {
      await import("~/server/jobs/cleanup-email-bodies");
    }

    const { CampaignSchedulerService } =
      await import("~/server/jobs/campaign-scheduler-job");
    await CampaignSchedulerService.start();

    initialized = true;
  }
}
