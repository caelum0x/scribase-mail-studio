import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "~/lib/constants/plans";
import { isEntitledSubscriptionStatus } from "~/lib/subscription-status";
import {
  isUpgrade,
  planFromProductId,
  productIdForPlan,
  teamStateForSubscription,
} from "./plan-mapping";

const IDS = { PRO: "pdt_pro", SCALE: "pdt_scale" };

describe("planFromProductId", () => {
  it("maps configured products to plans", () => {
    expect(planFromProductId("pdt_pro", IDS)).toBe("PRO");
    expect(planFromProductId("pdt_scale", IDS)).toBe("SCALE");
  });

  it("maps unknown or missing products to FREE", () => {
    expect(planFromProductId("pdt_other_app", IDS)).toBe("FREE");
    expect(planFromProductId(undefined, IDS)).toBe("FREE");
    expect(planFromProductId("pdt_pro", {})).toBe("FREE");
  });

  it("round-trips through productIdForPlan", () => {
    expect(productIdForPlan("SCALE", IDS)).toBe("pdt_scale");
    expect(productIdForPlan("PRO", { PRO: "" })).toBeUndefined();
  });
});

describe("teamStateForSubscription", () => {
  it("grants the plan for active and past_due", () => {
    expect(teamStateForSubscription("active", "PRO")).toEqual({
      plan: "PRO",
      isActive: true,
    });
    expect(teamStateForSubscription("past_due", "SCALE")).toEqual({
      plan: "SCALE",
      isActive: true,
    });
  });

  it("suspends paid limits while on hold", () => {
    expect(teamStateForSubscription("on_hold", "PRO")).toEqual({
      plan: "PRO",
      isActive: false,
    });
  });

  it("returns to an active free team when the subscription ends", () => {
    for (const status of ["cancelled", "expired", "failed"]) {
      expect(teamStateForSubscription(status, "SCALE")).toEqual({
        plan: "FREE",
        isActive: true,
      });
    }
  });
});

describe("plan helpers", () => {
  it("orders plans for upgrades", () => {
    expect(isUpgrade("FREE", "PRO")).toBe(true);
    expect(isUpgrade("PRO", "SCALE")).toBe(true);
    expect(isUpgrade("SCALE", "PRO")).toBe(false);
  });

  it("only entitles active and past_due", () => {
    expect(isEntitledSubscriptionStatus("active")).toBe(true);
    expect(isEntitledSubscriptionStatus("on_hold")).toBe(false);
    expect(isEntitledSubscriptionStatus(null)).toBe(false);
  });

  it("derives limits from the shared pricing config", () => {
    expect(PLAN_LIMITS.FREE).toMatchObject({
      emailsPerMonth: 3000,
      emailsPerDay: 100,
      domains: 1,
    });
    expect(PLAN_LIMITS.PRO).toMatchObject({
      emailsPerMonth: 50_000,
      emailsPerDay: -1,
      domains: 10,
    });
    expect(PLAN_LIMITS.SCALE).toMatchObject({
      emailsPerMonth: 100_000,
      emailsPerDay: -1,
      domains: 1000,
    });
  });
});
