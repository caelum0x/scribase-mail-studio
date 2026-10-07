import { getResendApp } from "./app";
import { registerEmailRoutes } from "./emails";
import { registerReceivedEmailRoutes } from "./received";

/**
 * Resend-compatible API. Each resource registers its routes here; Wave 1-3
 * add domains, api-keys, webhooks, suppressions, logs, contacts, ... in their
 * own files under this directory.
 */
export function buildResendApp() {
  const app = getResendApp();
  // Before the email routes: GET /emails/:id would otherwise match /emails/received.
  registerReceivedEmailRoutes(app);
  registerEmailRoutes(app);
  return app;
}

export const resendApp = buildResendApp();

export default resendApp;
