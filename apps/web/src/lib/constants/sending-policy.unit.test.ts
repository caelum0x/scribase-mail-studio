import { describe, expect, it } from "vitest";
import {
  evaluateReputation,
  FIRST_SENDS_REVIEW,
  getWarmupDailyLimit,
  isFirstSendsReviewRequired,
  REPUTATION_POLICY,
  SCREENING_POLICY,
} from "./sending-policy";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-07T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY_MS);

describe("getWarmupDailyLimit", () => {
  it("caps a brand-new team at the first tier", () => {
    expect(getWarmupDailyLimit(daysAgo(0), now)).toBe(50);
  });

  it("raises the cap as the team ages", () => {
    expect(getWarmupDailyLimit(daysAgo(3), now)).toBe(200);
    expect(getWarmupDailyLimit(daysAgo(7), now)).toBe(1000);
    expect(getWarmupDailyLimit(daysAgo(14), now)).toBe(5000);
  });

  it("returns -1 (no warm-up cap) after the warm-up period", () => {
    expect(getWarmupDailyLimit(daysAgo(30), now)).toBe(-1);
    expect(getWarmupDailyLimit(daysAgo(400), now)).toBe(-1);
  });

  it("treats a future createdAt as brand new", () => {
    expect(getWarmupDailyLimit(new Date(now.getTime() + DAY_MS), now)).toBe(50);
  });
});

describe("evaluateReputation", () => {
  it("is ok below the minimum sample size, whatever the rates", () => {
    const result = evaluateReputation({
      sent: REPUTATION_POLICY.minSent - 1,
      hardBounced: 50,
      complained: 10,
    });
    expect(result.status).toBe("ok");
  });

  it("is ok with healthy rates", () => {
    const result = evaluateReputation({
      sent: 1000,
      hardBounced: 5,
      complained: 0,
    });
    expect(result.status).toBe("ok");
    expect(result.bounceRate).toBeCloseTo(0.005);
  });

  it("warns at the bounce warning threshold", () => {
    const result = evaluateReputation({
      sent: 1000,
      hardBounced: 25,
      complained: 0,
    });
    expect(result.status).toBe("warning");
    expect(result.reason).toBe("BOUNCE_RATE");
  });

  it("pauses at the bounce pause threshold", () => {
    const result = evaluateReputation({
      sent: 1000,
      hardBounced: 40,
      complained: 0,
    });
    expect(result.status).toBe("paused");
    expect(result.reason).toBe("BOUNCE_RATE");
  });

  it("pauses on complaint rate once enough complaints exist", () => {
    const result = evaluateReputation({
      sent: 1000,
      hardBounced: 0,
      complained: 2,
    });
    expect(result.status).toBe("paused");
    expect(result.reason).toBe("COMPLAINT_RATE");
  });

  it("only warns on a single complaint even if the rate is high", () => {
    const result = evaluateReputation({
      sent: 200,
      hardBounced: 0,
      complained: 1,
    });
    expect(result.status).toBe("warning");
    expect(result.reason).toBe("COMPLAINT_RATE");
  });

  it("reports the worse problem when both are bad (pause beats warning)", () => {
    const result = evaluateReputation({
      sent: 1000,
      hardBounced: 25,
      complained: 3,
    });
    expect(result.status).toBe("paused");
    expect(result.reason).toBe("COMPLAINT_RATE");
  });
});

describe("isFirstSendsReviewRequired", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const hoursAgo = (h: number) => new Date(now.getTime() - h * HOUR_MS);
  const base = { isVerified: false, sendingTrustedAt: null };

  it("reviews a brand-new team's first sends", () => {
    expect(
      isFirstSendsReviewRequired({
        team: { ...base, createdAt: hoursAgo(1) },
        sentCount: 0,
        now,
      }),
    ).toBe(true);
  });

  it("keeps reviewing until both the email count and the age are reached", () => {
    // enough emails, too young
    expect(
      isFirstSendsReviewRequired({
        team: { ...base, createdAt: hoursAgo(10) },
        sentCount: FIRST_SENDS_REVIEW.emails,
        now,
      }),
    ).toBe(true);
    // old enough, too few emails
    expect(
      isFirstSendsReviewRequired({
        team: { ...base, createdAt: hoursAgo(FIRST_SENDS_REVIEW.hours + 1) },
        sentCount: FIRST_SENDS_REVIEW.emails - 1,
        now,
      }),
    ).toBe(true);
    // both reached
    expect(
      isFirstSendsReviewRequired({
        team: { ...base, createdAt: hoursAgo(FIRST_SENDS_REVIEW.hours) },
        sentCount: FIRST_SENDS_REVIEW.emails,
        now,
      }),
    ).toBe(false);
  });

  it("skips review for verified or trusted teams", () => {
    const createdAt = hoursAgo(1);
    expect(
      isFirstSendsReviewRequired({
        team: { ...base, createdAt, isVerified: true },
        sentCount: 0,
        now,
      }),
    ).toBe(false);
    expect(
      isFirstSendsReviewRequired({
        team: { ...base, createdAt, sendingTrustedAt: hoursAgo(0.5) },
        sentCount: 0,
        now,
      }),
    ).toBe(false);
  });

  it("is disabled when both limits are zero", () => {
    expect(
      isFirstSendsReviewRequired({
        team: { ...base, createdAt: hoursAgo(1) },
        sentCount: 0,
        now,
        policy: { emails: 0, hours: 0 },
      }),
    ).toBe(false);
  });

  it("accepts createdAt as a string (team cache)", () => {
    expect(
      isFirstSendsReviewRequired({
        team: { ...base, createdAt: hoursAgo(1).toISOString() },
        sentCount: 0,
        now,
      }),
    ).toBe(true);
  });
});

describe("SCREENING_POLICY", () => {
  it("holds before it rejects and blocks only on repeat offenses", () => {
    expect(SCREENING_POLICY.holdScore).toBeLessThan(
      SCREENING_POLICY.rejectScore,
    );
    expect(SCREENING_POLICY.strikesToBlock).toBeGreaterThan(1);
  });
});
