import { beforeEach, describe, expect, it, vi } from "vitest";
import { LimitReason } from "~/lib/constants/plans";

const { mockTeam, mockUsage } = vi.hoisted(() => ({
  mockTeam: { current: {} as Record<string, unknown> },
  mockUsage: { current: { day: [] as { sent: number }[], month: [] as { sent: number }[] } },
}));

vi.mock("~/env", () => ({ env: { NEXT_PUBLIC_IS_CLOUD: true } }));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/server/redis", () => ({
  withCache: async (_key: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("./usage-service", () => ({
  getThisMonthUsage: async () => mockUsage.current,
}));
vi.mock("./team-service", () => ({
  TeamService: {
    getTeamCached: async () => mockTeam.current,
    maybeNotifyEmailLimitReached: vi.fn(),
    sendWarningEmail: vi.fn(),
  },
}));

import { LimitService } from "./limit-service";

const DAY_MS = 24 * 60 * 60 * 1000;

function team(overrides: Record<string, unknown>) {
  return {
    id: 1,
    plan: "PRO",
    isActive: true,
    isBlocked: false,
    isVerified: false,
    dailyEmailLimit: 10000,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("LimitService.checkEmailLimit warm-up", () => {
  beforeEach(() => {
    mockUsage.current = { day: [{ sent: 0 }], month: [{ sent: 0 }] };
  });

  it("caps a new paid team at the warm-up limit", async () => {
    mockTeam.current = team({});
    mockUsage.current = { day: [{ sent: 50 }], month: [{ sent: 50 }] };

    const result = await LimitService.checkEmailLimit(1);

    expect(result.isLimitReached).toBe(true);
    expect(result.limit).toBe(50);
    expect(result.reason).toBe(LimitReason.EMAIL_DAILY_LIMIT_REACHED);
  });

  it("uses the team limit once warm-up is over", async () => {
    mockTeam.current = team({
      createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    });
    mockUsage.current = { day: [{ sent: 5000 }], month: [{ sent: 5000 }] };

    const result = await LimitService.checkEmailLimit(1);

    expect(result.isLimitReached).toBe(false);
    expect(result.limit).toBe(10000);
  });

  it("skips warm-up for admin-verified teams", async () => {
    mockTeam.current = team({ isVerified: true });
    mockUsage.current = { day: [{ sent: 500 }], month: [{ sent: 500 }] };

    const result = await LimitService.checkEmailLimit(1);

    expect(result.isLimitReached).toBe(false);
    expect(result.limit).toBe(10000);
  });

  it("keeps the lower plan limit when it is below the warm-up limit", async () => {
    mockTeam.current = team({
      plan: "FREE",
      createdAt: new Date(Date.now() - 20 * DAY_MS).toISOString(),
    });

    const result = await LimitService.checkEmailLimit(1);

    expect(result.limit).toBe(100);
  });

  it("still blocks paused teams first", async () => {
    mockTeam.current = team({ isBlocked: true });

    const result = await LimitService.checkEmailLimit(1);

    expect(result.isLimitReached).toBe(true);
    expect(result.reason).toBe(LimitReason.EMAIL_BLOCKED);
  });
});
