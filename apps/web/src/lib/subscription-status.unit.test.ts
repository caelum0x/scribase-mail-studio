import { describe, expect, it } from "vitest";
import { isEntitledSubscriptionStatus } from "~/lib/subscription-status";

describe("isEntitledSubscriptionStatus (Dodo statuses)", () => {
  it("treats active and past_due subscriptions as entitled", () => {
    expect(isEntitledSubscriptionStatus("active")).toBe(true);
    expect(isEntitledSubscriptionStatus("past_due")).toBe(true);
  });

  it("treats held, ended or pending subscriptions as not entitled", () => {
    for (const status of [
      "on_hold",
      "paused",
      "pending",
      "cancelled",
      "failed",
      "expired",
    ]) {
      expect(isEntitledSubscriptionStatus(status)).toBe(false);
    }
    expect(isEntitledSubscriptionStatus(null)).toBe(false);
    expect(isEntitledSubscriptionStatus(undefined)).toBe(false);
  });
});
