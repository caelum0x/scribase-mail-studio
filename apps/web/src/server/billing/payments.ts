import type { Plan } from "@prisma/client";
import { env } from "~/env";
import { isEntitledSubscriptionStatus } from "~/lib/subscription-status";
import { db } from "../db";
import { logger } from "../logger/log";
import { TeamService } from "../service/team-service";
import {
  BillingNotConfiguredError,
  getDodoClient,
  getProductIds,
  isBillingConfigured,
} from "./dodo-client";
import { type PaidPlan, isUpgrade, productIdForPlan } from "./plan-mapping";

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

function requireProductId(plan: PaidPlan): string {
  const productId = productIdForPlan(plan, getProductIds());
  if (!productId) {
    throw new BillingNotConfiguredError(`No Dodo product configured for ${plan}`);
  }
  return productId;
}

async function getTeamOrThrow(teamId: number) {
  const team = await db.team.findUnique({ where: { id: teamId } });
  if (!team) throw new BillingError("Team not found");
  return team;
}

/** The team's current paid subscription in our records, if any. */
export async function getLiveSubscription(teamId: number) {
  const subs = await db.subscription.findMany({
    where: { teamId, provider: "dodo" },
    orderBy: { updatedAt: "desc" },
  });
  return subs.find((s) => isEntitledSubscriptionStatus(s.status)) ?? null;
}

async function resolveBillingEmail(team: {
  id: number;
  billingEmail: string | null;
}): Promise<string> {
  if (team.billingEmail) return team.billingEmail;
  const users = await TeamService.getTeamUsers(team.id);
  const admin = users.find((tu) => tu.role === "ADMIN" && tu.user?.email);
  const email = admin?.user?.email ?? users.find((tu) => tu.user?.email)?.user?.email;
  if (!email) throw new BillingError("Set a billing email first");
  return email;
}

/** Dodo customer id for the team, creating the customer on first use. */
async function ensureCustomer(teamId: number): Promise<string> {
  const team = await getTeamOrThrow(teamId);
  if (team.billingCustomerId) return team.billingCustomerId;

  const email = await resolveBillingEmail(team);
  const customer = await getDodoClient().customers.create({
    email,
    name: team.name,
    metadata: { teamId: String(team.id), app: "scribase-mail" },
  });

  await TeamService.updateTeam(teamId, {
    billingCustomerId: customer.customer_id,
    billingEmail: team.billingEmail ?? email,
  });
  return customer.customer_id;
}

/**
 * Hosted Dodo checkout for a paid plan. Access is granted only by the
 * verified subscription.active webhook, never by the return URL.
 */
export async function createCheckoutSessionForTeam(
  teamId: number,
  plan: PaidPlan,
): Promise<{ url: string }> {
  if (!isBillingConfigured()) throw new BillingNotConfiguredError();
  const productId = requireProductId(plan);

  if (await getLiveSubscription(teamId)) {
    throw new BillingError(
      "Team already has a subscription. Change the plan instead.",
    );
  }

  const customerId = await ensureCustomer(teamId);
  const session = await getDodoClient().checkoutSessions.create({
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { customer_id: customerId },
    return_url: `${env.NEXTAUTH_URL}/payments?success=true`,
    cancel_url: `${env.NEXTAUTH_URL}/settings/billing`,
    metadata: { teamId: String(teamId), plan, app: "scribase-mail" },
  });

  if (!session.checkout_url) {
    throw new BillingError("Checkout could not be started");
  }
  return { url: session.checkout_url };
}

/** Self-service portal: invoices, payment method, cancel. */
export async function getManageSessionUrl(teamId: number): Promise<string> {
  if (!isBillingConfigured()) throw new BillingNotConfiguredError();
  const team = await getTeamOrThrow(teamId);
  if (!team.billingCustomerId) {
    throw new BillingError("Team has no billing account yet");
  }
  const portal = await getDodoClient().customers.customerPortal.create(
    team.billingCustomerId,
    { return_url: `${env.NEXTAUTH_URL}/settings/billing` },
  );
  return portal.link;
}

/**
 * Switch an existing subscription between paid plans. Upgrades are charged
 * prorated immediately; downgrades are credited prorated. The team's plan is
 * updated by the subscription.plan_changed webhook.
 */
export async function changeTeamPlan(
  teamId: number,
  plan: PaidPlan,
): Promise<void> {
  if (!isBillingConfigured()) throw new BillingNotConfiguredError();
  const productId = requireProductId(plan);
  const live = await getLiveSubscription(teamId);
  if (!live) throw new BillingError("No active subscription to change");
  if (live.productId === productId) return;

  await getDodoClient().subscriptions.changePlan(live.id, {
    product_id: productId,
    quantity: 1,
    proration_billing_mode: "prorated_immediately",
    on_payment_failure: isUpgrade(live.plan as Plan, plan)
      ? "prevent_change"
      : "apply_change",
  });
  logger.info({ teamId, plan }, "[Billing]: Requested plan change");
}

/** Cancel at the end of the paid period; the team keeps its plan until then. */
export async function cancelTeamSubscription(teamId: number): Promise<void> {
  if (!isBillingConfigured()) throw new BillingNotConfiguredError();
  const live = await getLiveSubscription(teamId);
  if (!live) throw new BillingError("No active subscription to cancel");

  await getDodoClient().subscriptions.update(live.id, {
    cancel_at_next_billing_date: true,
  });
  await db.subscription.update({
    where: { id: live.id },
    data: { cancelAtPeriodEnd: live.currentPeriodEnd ?? new Date() },
  });
  logger.info({ teamId }, "[Billing]: Scheduled cancellation");
}

/** Undo a scheduled cancellation. */
export async function resumeTeamSubscription(teamId: number): Promise<void> {
  if (!isBillingConfigured()) throw new BillingNotConfiguredError();
  const live = await getLiveSubscription(teamId);
  if (!live) throw new BillingError("No active subscription to resume");

  await getDodoClient().subscriptions.update(live.id, {
    cancel_at_next_billing_date: false,
  });
  await db.subscription.update({
    where: { id: live.id },
    data: { cancelAtPeriodEnd: null },
  });
}
