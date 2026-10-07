import { getResendApp } from "./app";
import { registerEmailRoutes } from "./emails";
import { registerWebhookRoutes } from "./webhooks";
import { registerSuppressionRoutes } from "./suppressions";
import { registerLogRoutes } from "./logs";
import { requestLogMiddleware } from "../request-log-middleware";

/**
 * Resend-compatible API. Each resource registers its routes here; Wave 1-3
 * add domains, api-keys, webhooks, suppressions, logs, contacts, ... in their
 * own files under this directory.
 */
export function buildResendApp() {
  const app = getResendApp();

  // Async request logging middleware (fire-and-forget, never fails a request).
  app.use("*", requestLogMiddleware);

  registerEmailRoutes(app);
  registerWebhookRoutes(app);
  registerSuppressionRoutes(app);
  registerLogRoutes(app);
  return app;
}

export const resendApp = buildResendApp();

export default resendApp;
