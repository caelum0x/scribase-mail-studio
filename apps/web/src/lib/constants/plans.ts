import { Plan } from "@prisma/client";
import { PRICING_PLANS } from "@usesend/lib/src/constants/pricing";

export enum LimitReason {
  DOMAIN = "DOMAIN",
  CONTACT_BOOK = "CONTACT_BOOK",
  TEAM_MEMBER = "TEAM_MEMBER",
  WEBHOOK = "WEBHOOK",
  EMAIL_BLOCKED = "EMAIL_BLOCKED",
  EMAIL_DAILY_LIMIT_REACHED = "EMAIL_DAILY_LIMIT_REACHED",
  EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED = "EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED",
}

type PlanLimits = {
  emailsPerMonth: number;
  emailsPerDay: number;
  domains: number;
  contactBooks: number;
  teamMembers: number;
  webhooks: number;
};

function limitsFor(plan: Plan): PlanLimits {
  const p = PRICING_PLANS[plan];
  return {
    emailsPerMonth: p.emailsPerMonth,
    emailsPerDay: p.emailsPerDay,
    domains: p.domains,
    contactBooks: p.contactBooks,
    teamMembers: p.teamMembers,
    webhooks: p.webhooks,
  };
}

/**
 * Enforced limits per plan, derived from the shared pricing config
 * (packages/lib/src/constants/pricing.ts). Paid plans have no monthly hard
 * cap: sends above the quota are billed as overage through Dodo Payments.
 */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: limitsFor("FREE"),
  PRO: limitsFor("PRO"),
  SCALE: limitsFor("SCALE"),
};
