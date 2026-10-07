/**
 * Scribase Mail pricing: the single source of truth for plan prices and
 * quotas. Used by the app (limits, billing UI, overage estimates) and by the
 * marketing pricing page. Changing a price here does NOT change what Dodo
 * Payments charges: keep the Dodo products and meter in sync (deploy/DEPLOY.md).
 *
 * -1 means unlimited.
 */

export type PricingPlanId = "FREE" | "PRO" | "SCALE";

export interface PricingPlan {
  id: PricingPlanId;
  name: string;
  /** Monthly subscription price in USD. */
  priceUsdMonthly: number;
  /** Emails included in the subscription each month. */
  emailsPerMonth: number;
  /** Hard daily cap; -1 = no plan cap (abuse and warm-up caps still apply). */
  emailsPerDay: number;
  domains: number;
  contactBooks: number;
  teamMembers: number;
  webhooks: number;
  /**
   * Price in USD per 1,000 emails sent above emailsPerMonth.
   * null = no overage: sending stops at the monthly quota.
   */
  overageUsdPer1000: number | null;
  description: string;
  features: string[];
}

export const PRICING_PLANS: Record<PricingPlanId, PricingPlan> = {
  FREE: {
    id: "FREE",
    name: "Free",
    priceUsdMonthly: 0,
    emailsPerMonth: 3_000,
    emailsPerDay: 100,
    domains: 1,
    contactBooks: 1,
    teamMembers: 1,
    webhooks: 1,
    overageUsdPer1000: null,
    description: "For trying Scribase Mail and side projects.",
    features: [
      "3,000 emails per month",
      "100 emails per day",
      "1 domain",
      "1 contact book",
      "1 team member",
    ],
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    priceUsdMonthly: 20,
    emailsPerMonth: 50_000,
    emailsPerDay: -1,
    domains: 10,
    contactBooks: -1,
    teamMembers: -1,
    webhooks: -1,
    overageUsdPer1000: 0.9,
    description: "For products sending to real customers.",
    features: [
      "50,000 emails per month",
      "No daily sending cap",
      "10 domains",
      "Unlimited contact books and team members",
      "$0.90 per 1,000 extra emails",
    ],
  },
  SCALE: {
    id: "SCALE",
    name: "Scale",
    priceUsdMonthly: 90,
    emailsPerMonth: 100_000,
    emailsPerDay: -1,
    domains: 1_000,
    contactBooks: -1,
    teamMembers: -1,
    webhooks: -1,
    overageUsdPer1000: 0.9,
    description: "For teams with high volume and many domains.",
    features: [
      "100,000 emails per month",
      "No daily sending cap",
      "1,000 domains",
      "Unlimited contact books and team members",
      "$0.90 per 1,000 extra emails",
    ],
  },
};

export const PRICING_PLAN_ORDER: PricingPlanId[] = ["FREE", "PRO", "SCALE"];

export const PAID_PLAN_IDS: Exclude<PricingPlanId, "FREE">[] = ["PRO", "SCALE"];

/** Emails above the plan's monthly quota (0 when within quota). */
export function getOverageEmails(
  planId: PricingPlanId,
  emailsThisPeriod: number,
): number {
  const plan = PRICING_PLANS[planId];
  if (plan.emailsPerMonth === -1) return 0;
  return Math.max(0, emailsThisPeriod - plan.emailsPerMonth);
}

/** Estimated overage charge in USD for the period, rounded to cents. */
export function getOverageCostUsd(
  planId: PricingPlanId,
  emailsThisPeriod: number,
): number {
  const plan = PRICING_PLANS[planId];
  if (plan.overageUsdPer1000 === null) return 0;
  const extra = getOverageEmails(planId, emailsThisPeriod);
  return Math.round(((extra / 1000) * plan.overageUsdPer1000) * 100) / 100;
}

/** Per-email price Dodo's meter should charge (overage per 1,000 / 1,000). */
export function getOveragePricePerEmailUsd(planId: PricingPlanId): number {
  const per1000 = PRICING_PLANS[planId].overageUsdPer1000;
  return per1000 === null ? 0 : per1000 / 1000;
}
