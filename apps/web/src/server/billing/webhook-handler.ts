import type { Plan, Prisma } from "@prisma/client";
import { isEntitledSubscriptionStatus } from "~/lib/subscription-status";
import { db } from "../db";
import { logger } from "../logger/log";
import { sendSubscriptionConfirmationEmail } from "../mailer";
import { TeamService } from "../service/team-service";
import { getDodoClient, getProductIds } from "./dodo-client";
import { planFromProductId, teamStateForSubscription } from "./plan-mapping";

/** Minimal shape of a Dodo event; the SDK's unwrap() returns a superset. */
export interface DodoWebhookEvent {
  type: string;
  data: unknown;
}

/** The subset of a Dodo Subscription payload billing depends on. */
export interface SubscriptionSnapshot {
  subscription_id: string;
  status: string;
  product_id: string;
  customer: { customer_id: string; email?: string | null };
  metadata?: Record<string, string | number | boolean> | null;
  next_billing_date?: string | null;
  previous_billing_date?: string | null;
  cancel_at_next_billing_date?: boolean | null;
}

export type WebhookOutcome =
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | {
      status: "processed";
      teamId: number;
      plan: Plan;
      isActive: boolean;
      becamePaid: boolean;
    };

const SUBSCRIPTION_EVENTS = new Set([
  "subscription.active",
  "subscription.updated",
  "subscription.renewed",
  "subscription.on_hold",
  "subscription.plan_changed",
  "subscription.cancelled",
  "subscription.failed",
  "subscription.expired",
  "subscription.past_due",
  "subscription.paused",
  "subscription.unpaused",
]);

const PAYMENT_EVENTS = new Set(["payment.succeeded", "payment.failed"]);

export const HANDLED_EVENT_TYPES = [...SUBSCRIPTION_EVENTS, ...PAYMENT_EVENTS];

type Tx = Prisma.TransactionClient;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function toSubscriptionSnapshot(
  data: unknown,
): SubscriptionSnapshot | null {
  if (!isObject(data)) return null;
  const customer = data.customer;
  if (
    typeof data.subscription_id !== "string" ||
    typeof data.status !== "string" ||
    typeof data.product_id !== "string" ||
    !isObject(customer) ||
    typeof customer.customer_id !== "string"
  ) {
    return null;
  }
  return data as unknown as SubscriptionSnapshot;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function teamIdFromMetadata(
  metadata: SubscriptionSnapshot["metadata"],
): number | null {
  const raw = metadata?.teamId;
  const id = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Resolve the subscription the event is about. Subscription events carry the
 * full, latest subscription; payment events only reference it, so the
 * current state is fetched from Dodo (payload freshness beats event order).
 */
async function resolveSnapshot(
  event: DodoWebhookEvent,
): Promise<SubscriptionSnapshot | { ignored: string }> {
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const snap = toSubscriptionSnapshot(event.data);
    return snap ?? { ignored: "malformed subscription payload" };
  }
  if (PAYMENT_EVENTS.has(event.type)) {
    const subscriptionId = isObject(event.data)
      ? event.data.subscription_id
      : undefined;
    if (typeof subscriptionId !== "string" || !subscriptionId) {
      return { ignored: "payment without subscription" };
    }
    const sub = await getDodoClient().subscriptions.retrieve(subscriptionId);
    const snap = toSubscriptionSnapshot(sub);
    return snap ?? { ignored: "malformed subscription from API" };
  }
  return { ignored: `unhandled event type ${event.type}` };
}

async function findTeam(tx: Tx, snap: SubscriptionSnapshot) {
  const byCustomer = await tx.team.findUnique({
    where: { billingCustomerId: snap.customer.customer_id },
  });
  if (byCustomer) return byCustomer;

  const teamId = teamIdFromMetadata(snap.metadata);
  if (!teamId) return null;
  const byMetadata = await tx.team.findUnique({ where: { id: teamId } });
  // Never re-point a team that is already bound to a different customer.
  if (byMetadata?.billingCustomerId) return null;
  return byMetadata;
}

async function applySubscription(
  tx: Tx,
  snap: SubscriptionSnapshot,
): Promise<WebhookOutcome> {
  const plan = planFromProductId(snap.product_id, getProductIds());
  if (plan === "FREE") {
    // Shared Dodo business: events for other products are not ours.
    return { status: "ignored", reason: "product not a Scribase Mail plan" };
  }

  const team = await findTeam(tx, snap);
  if (!team) {
    return { status: "ignored", reason: "no team for customer" };
  }

  const nextBilling = parseDate(snap.next_billing_date);
  const record = {
    teamId: team.id,
    provider: "dodo",
    customerId: snap.customer.customer_id,
    status: snap.status,
    plan,
    productId: snap.product_id,
    productIds: [snap.product_id],
    currentPeriodStart: parseDate(snap.previous_billing_date),
    currentPeriodEnd: nextBilling,
    cancelAtPeriodEnd: snap.cancel_at_next_billing_date ? nextBilling : null,
    paymentMethod: null,
  };

  await tx.subscription.upsert({
    where: { id: snap.subscription_id },
    update: record,
    create: { id: snap.subscription_id, ...record },
  });

  const wasPaid = team.isActive && team.plan !== "FREE";
  const next = teamStateForSubscription(snap.status, plan);

  if (!isEntitledSubscriptionStatus(snap.status)) {
    // An old subscription ending must not downgrade a team that already
    // moved to another live subscription.
    const otherLive = await tx.subscription.findFirst({
      where: {
        teamId: team.id,
        provider: "dodo",
        id: { not: snap.subscription_id },
        status: { in: ["active", "past_due"] },
      },
    });
    if (otherLive) {
      return {
        status: "processed",
        teamId: team.id,
        plan: team.plan,
        isActive: team.isActive,
        becamePaid: false,
      };
    }
  }

  await tx.team.update({
    where: { id: team.id },
    data: {
      plan: next.plan,
      isActive: next.isActive,
      ...(team.billingCustomerId
        ? {}
        : { billingCustomerId: snap.customer.customer_id }),
    },
  });

  const isNowPaid = next.isActive && next.plan !== "FREE";
  return {
    status: "processed",
    teamId: team.id,
    plan: next.plan,
    isActive: next.isActive,
    becamePaid: !wasPaid && isNowPaid,
  };
}

/**
 * Process one verified Dodo webhook exactly once. The idempotency claim
 * (BillingWebhookEvent keyed by webhook-id) and all billing writes commit in
 * a single transaction: if anything throws, both roll back and Dodo's retry
 * can claim the event again.
 */
export async function processDodoWebhook(
  webhookId: string,
  event: DodoWebhookEvent,
): Promise<WebhookOutcome> {
  if (!webhookId) {
    throw new Error("webhook-id is required");
  }

  const resolved = await resolveSnapshot(event);

  return db.$transaction(async (tx) => {
    const claim = await tx.billingWebhookEvent.createMany({
      data: [{ id: webhookId, provider: "dodo", type: event.type }],
      skipDuplicates: true,
    });
    if (claim.count === 0) {
      return { status: "duplicate" } as const;
    }

    if ("ignored" in resolved) {
      logger.info(
        { webhookId, type: event.type, reason: resolved.ignored },
        "[Billing]: Ignored Dodo webhook",
      );
      return { status: "ignored", reason: resolved.ignored } as const;
    }

    return applySubscription(tx, resolved);
  });
}

/**
 * Side effects that must only run after the billing transaction committed:
 * refresh the cached team (LimitService reads it) and send the one-time
 * subscription confirmation. Failures here are logged, never rethrown, so a
 * committed event is not redelivered just because an email failed.
 */
export async function afterDodoWebhook(outcome: WebhookOutcome): Promise<void> {
  if (outcome.status !== "processed") return;

  try {
    await TeamService.refreshTeamCache(outcome.teamId);
  } catch (err) {
    logger.error(
      { err, teamId: outcome.teamId },
      "[Billing]: Failed to refresh team cache after webhook",
    );
  }

  if (!outcome.becamePaid) return;

  try {
    const teamUsers = await TeamService.getTeamUsers(outcome.teamId);
    await Promise.all(
      teamUsers
        .map((tu) => tu.user?.email)
        .filter((email): email is string => Boolean(email))
        .map((email) => sendSubscriptionConfirmationEmail(email)),
    );
  } catch (err) {
    logger.error(
      { err, teamId: outcome.teamId },
      "[Billing]: Failed sending subscription confirmation email",
    );
  }
}
