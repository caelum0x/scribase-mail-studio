/**
 * Provider-neutral subscription statuses that grant paid-plan access.
 * Dodo Payments statuses: pending, active, on_hold, paused, cancelled, failed,
 * expired, past_due. "past_due" is a short grace window; "on_hold" means a
 * renewal payment failed and the team falls back to free-plan limits until
 * the customer fixes the payment method.
 */
const ENTITLED_SUBSCRIPTION_STATUSES = new Set(["active", "past_due"]);

export function isEntitledSubscriptionStatus(
  status: string | null | undefined,
) {
  return Boolean(status && ENTITLED_SUBSCRIPTION_STATUSES.has(status));
}
