import type { Plan } from "@prisma/client";
import { isEntitledSubscriptionStatus } from "~/lib/subscription-status";

export type PaidPlan = Exclude<Plan, "FREE">;

export const PAID_PLANS: readonly PaidPlan[] = ["PRO", "SCALE"] as const;

export type ProductIds = Partial<Record<PaidPlan, string | undefined>>;

export function isPaidPlan(plan: string): plan is PaidPlan {
  return (PAID_PLANS as readonly string[]).includes(plan);
}

/** Dodo product id -> plan. Unknown products map to FREE. */
export function planFromProductId(
  productId: string | null | undefined,
  productIds: ProductIds,
): Plan {
  if (!productId) return "FREE";
  for (const plan of PAID_PLANS) {
    if (productIds[plan] && productIds[plan] === productId) return plan;
  }
  return "FREE";
}

export function productIdForPlan(
  plan: PaidPlan,
  productIds: ProductIds,
): string | undefined {
  return productIds[plan] || undefined;
}

export interface TeamBillingState {
  plan: Plan;
  isActive: boolean;
}

/**
 * Team plan/isActive for a subscription in a given status.
 *
 * - active / past_due: the subscribed plan, active.
 * - on_hold / paused / pending: keep the plan but mark inactive, so limits
 *   fall back to FREE until payment recovers (LimitService treats inactive
 *   teams as FREE). Recovery flips it back without a plan lookup.
 * - cancelled / expired / failed: back to an active FREE team.
 */
export function teamStateForSubscription(
  status: string,
  plan: Plan,
): TeamBillingState {
  if (isEntitledSubscriptionStatus(status)) {
    return plan === "FREE"
      ? { plan: "FREE", isActive: true }
      : { plan, isActive: true };
  }
  if (status === "on_hold" || status === "paused" || status === "pending") {
    return { plan, isActive: false };
  }
  return { plan: "FREE", isActive: true };
}

/** Whether a team on `from` is upgrading by moving to `to`. */
export function isUpgrade(from: Plan, to: Plan): boolean {
  const rank: Record<Plan, number> = { FREE: 0, PRO: 1, SCALE: 2 };
  return rank[to] > rank[from];
}
