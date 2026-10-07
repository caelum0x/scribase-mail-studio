import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOverageCostUsd,
  getOverageEmails,
} from "@usesend/lib/src/constants/pricing";
import { getUsageDate, getUsageDates } from "~/lib/usage";

describe("usage helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns yesterday's date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-08T12:00:00.000Z"));

    expect(getUsageDate()).toBe("2026-02-07");
  });

  it("returns the last N completed UTC days, newest first", () => {
    const now = new Date("2026-03-01T00:30:00.000Z");
    expect(getUsageDates(3, now)).toEqual([
      "2026-02-28",
      "2026-02-27",
      "2026-02-26",
    ]);
  });
});

describe("overage pricing", () => {
  it("charges nothing within the quota", () => {
    expect(getOverageEmails("PRO", 50_000)).toBe(0);
    expect(getOverageCostUsd("PRO", 49_999)).toBe(0);
  });

  it("charges $0.90 per 1,000 emails over the Pro quota", () => {
    expect(getOverageEmails("PRO", 60_000)).toBe(10_000);
    expect(getOverageCostUsd("PRO", 60_000)).toBe(9);
  });

  it("uses the Scale quota", () => {
    expect(getOverageCostUsd("SCALE", 100_500)).toBe(0.45);
  });

  it("never bills overage on Free", () => {
    expect(getOverageCostUsd("FREE", 10_000)).toBe(0);
  });
});
