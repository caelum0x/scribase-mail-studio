import { getResendApp } from "./app";
import { registerEmailRoutes } from "./emails";
import { registerReceivedEmailRoutes } from "./received";
import { registerDomainRoutes } from "./domains";
import { registerApiKeyRoutes } from "./api-keys";
import { registerTopicRoutes } from "./topics";
import { registerSegmentRoutes } from "./segments";
import { registerAudienceRoutes } from "./audiences";
import { registerContactRoutes } from "./contacts";
import { registerContactPropertyRoutes } from "./contact-properties";
import { registerTemplateRoutes } from "./templates";
import { registerBroadcastRoutes } from "./broadcasts";
import { registerAttachmentRoutes } from "./attachments";
import { registerShareRoutes } from "./share";
import { registerMetricsRoutes } from "./metrics";
import { registerWebhookRoutes } from "./webhooks";
import { registerSuppressionRoutes } from "./suppressions";
import { registerLogRoutes } from "./logs";
import { requestLogMiddleware } from "../request-log-middleware";

/**
 * Resend-compatible API. Each resource registers its routes here, in its own
 * file under this directory.
 */
export function buildResendApp() {
  const app = getResendApp();

  // Async request logging (fire-and-forget); registered first so it wraps
  // every route below.
  app.use("*", requestLogMiddleware);

  // Fixed /emails/<word> paths go before the wildcard GET /emails/:id.
  registerMetricsRoutes(app);
  registerReceivedEmailRoutes(app);
  registerEmailRoutes(app);

  registerDomainRoutes(app);
  registerApiKeyRoutes(app);
  registerWebhookRoutes(app);
  registerSuppressionRoutes(app);
  registerLogRoutes(app);

  registerContactRoutes(app);
  registerTopicRoutes(app);
  registerSegmentRoutes(app);
  registerAudienceRoutes(app);
  registerContactPropertyRoutes(app);

  registerBroadcastRoutes(app);
  registerTemplateRoutes(app);

  registerAttachmentRoutes(app);
  registerShareRoutes(app);

  return app;
}

export const resendApp = buildResendApp();

export default resendApp;
