import { getResendApp } from "./app";
import { registerEmailRoutes } from "./emails";
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

/**
 * Resend-compatible API. Each resource registers its routes here.
 *
 * Wave 1: emails (A1), domains + api-keys (A2), webhooks (A3), suppressions + logs (A4).
 * Wave 2: contacts/topics/segments (B1), broadcasts + templates (B2), attachments/share/metrics (B3).
 */
export function buildResendApp() {
  const app = getResendApp();

  // Wave 2 — B3 metrics: must be registered BEFORE Wave 1 emails because
  // GET /emails/metrics must win over the wildcard GET /emails/:id.
  registerMetricsRoutes(app);

  // Wave 1 — emails (A1). Others (A2-A4) registered by their own agents.
  registerEmailRoutes(app);

  // Wave 2 — B1: contacts, topics, segments, audiences (alias), contact properties
  registerContactRoutes(app);
  registerTopicRoutes(app);
  registerSegmentRoutes(app);
  registerAudienceRoutes(app);
  registerContactPropertyRoutes(app);

  // Wave 2 — B2: broadcasts (campaign alias) + templates
  registerBroadcastRoutes(app);
  registerTemplateRoutes(app);

  // Wave 2 — B3: attachments, share
  registerAttachmentRoutes(app);
  registerShareRoutes(app);

  return app;
}

export const resendApp = buildResendApp();

export default resendApp;
