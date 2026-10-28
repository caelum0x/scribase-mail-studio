import { PRICING_PLAN_ORDER, type PricingPlanId } from "@usesend/lib/src/constants/pricing";

/**
 * The marketing site's "Choose Pro" / "Choose Scale" buttons on
 * scribase.com/mail link straight to `/signup` with no way to carry the
 * visitor's plan intent across the sign-up flow: a visitor who clicked
 * "Choose Pro" previously landed on the exact same generic dashboard as
 * someone who clicked "Create a free account", with no memory of which
 * plan they picked. They then had to independently find Settings > Billing
 * and pick Pro again — a real dead-end for anyone who clicked with payment
 * intent.
 *
 * `?plan=pro` (or `?plan=scale`) on `/login` or `/signup` now survives the
 * whole OTP/OAuth round trip (the OTP flow never leaves the tab, so the
 * query param is still in `window.location` when the code is submitted) and
 * is normalized here into the plan id billing actually understands.
 */
export function parsePlanIntent(
  rawPlan: string | null | undefined,
): Exclude<PricingPlanId, "FREE"> | null {
  if (!rawPlan) return null;
  const normalized = rawPlan.trim().toUpperCase();
  if (normalized === "PRO" || normalized === "SCALE") {
    return normalized as "PRO" | "SCALE";
  }
  return null;
}

export function isValidPlanId(value: string): value is PricingPlanId {
  return (PRICING_PLAN_ORDER as string[]).includes(value);
}

/**
 * Where to send a user right after they finish signing in/up. Keeps the
 * existing invite-flow behavior unchanged and otherwise sends anyone with a
 * remembered plan intent straight to billing (pre-highlighted there) instead
 * of the generic dashboard.
 */
export function getPostAuthPath(options: {
  inviteId?: string | null;
  plan?: string | null;
}): string {
  const { inviteId, plan } = options;

  if (inviteId) {
    return `/join-team?inviteId=${inviteId}`;
  }

  const planIntent = parsePlanIntent(plan);
  if (planIntent) {
    return `/settings/billing?plan=${planIntent}`;
  }

  return "/dashboard";
}
