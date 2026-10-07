import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnv,
  mockDb,
  mockRedis,
  mockScreen,
  mockRecordStrike,
  mockNotifyAdmin,
  mockTeam,
  mockInvalidate,
} = vi.hoisted(() => ({
  mockEnv: {
    NEXT_PUBLIC_IS_CLOUD: true,
    NEXTAUTH_URL: "https://mail.scribase.com",
    ADMIN_EMAIL: "admin@scribase.com" as string | undefined,
    FIRST_SENDS_REVIEW_EMAILS: undefined as number | undefined,
    FIRST_SENDS_REVIEW_HOURS: undefined as number | undefined,
  },
  mockDb: {
    $transaction: vi.fn(),
    email: { update: vi.fn() },
    emailEvent: { create: vi.fn() },
    emailReview: { upsert: vi.fn(), count: vi.fn() },
    dailyEmailUsage: { aggregate: vi.fn() },
    team: { updateMany: vi.fn() },
  },
  mockRedis: { set: vi.fn() },
  mockScreen: vi.fn(),
  mockRecordStrike: vi.fn(),
  mockNotifyAdmin: vi.fn(),
  mockTeam: { current: {} as Record<string, unknown> },
  mockInvalidate: vi.fn(),
}));

vi.mock("~/env", () => ({ env: mockEnv }));
vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (k: string) => k,
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./content-screening-service", () => ({
  ContentScreeningService: {
    screen: mockScreen,
    recordStrike: mockRecordStrike,
    notifyAdmin: mockNotifyAdmin,
  },
}));
vi.mock("./team-service", () => ({
  TeamService: {
    getTeamCached: async () => mockTeam.current,
    invalidateTeamCache: mockInvalidate,
  },
}));

import { gateOutgoingEmail, needsFirstSendsReview } from "./send-gate-service";

const HOUR_MS = 60 * 60 * 1000;
const now = new Date("2026-10-07T12:00:00Z");

const email = {
  id: "em_1",
  teamId: 7,
  subject: "Hi",
  html: "<p>Hi</p>",
  text: null,
  campaignId: null,
};

const allow = { action: "allow", score: 0, strike: false, findings: [] };
const hold = {
  action: "hold",
  score: 0,
  strike: false,
  findings: [
    {
      code: "URL_SHORTENER",
      severity: "hold",
      score: 0,
      message: "Link through a URL shortener hides the destination",
      detail: "bit.ly",
    },
  ],
};
const reject = {
  action: "reject",
  score: 0,
  strike: true,
  findings: [
    {
      code: "MALICIOUS_URL",
      severity: "reject",
      score: 0,
      message: "Link to a known phishing or malware host",
      detail: "evil.test",
    },
  ],
};

function trustedTeam() {
  return {
    id: 7,
    isVerified: false,
    sendingTrustedAt: new Date(now.getTime() - HOUR_MS).toISOString(),
    createdAt: new Date(now.getTime() - 100 * HOUR_MS).toISOString(),
  };
}

function newTeam() {
  return {
    id: 7,
    isVerified: false,
    sendingTrustedAt: null,
    createdAt: new Date(now.getTime() - HOUR_MS).toISOString(),
  };
}

describe("gateOutgoingEmail", () => {
  beforeEach(() => {
    mockEnv.NEXT_PUBLIC_IS_CLOUD = true;
    mockEnv.FIRST_SENDS_REVIEW_EMAILS = undefined;
    mockEnv.FIRST_SENDS_REVIEW_HOURS = undefined;
    mockDb.$transaction.mockResolvedValue([]);
    mockDb.dailyEmailUsage.aggregate.mockResolvedValue({ _sum: { sent: 0 } });
    mockDb.emailReview.count.mockResolvedValue(3);
    mockRedis.set.mockResolvedValue("OK");
    mockTeam.current = trustedTeam();
  });

  it("sends clean mail from a trusted team", async () => {
    mockScreen.mockResolvedValue(allow);
    const decision = await gateOutgoingEmail({
      email,
      attachments: [],
      isBulk: false,
      now,
    });
    expect(decision).toBe("send");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("rejects malicious mail: FAILED status, event, strike", async () => {
    mockScreen.mockResolvedValue(reject);
    const decision = await gateOutgoingEmail({
      email,
      attachments: [],
      isBulk: false,
      now,
    });
    expect(decision).toBe("rejected");
    expect(mockDb.email.update).toHaveBeenCalledWith({
      where: { id: "em_1" },
      data: { latestStatus: "FAILED" },
    });
    expect(mockDb.emailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "FAILED",
        data: expect.objectContaining({
          error: expect.stringContaining("evil.test"),
        }),
      }),
    });
    expect(mockRecordStrike).toHaveBeenCalledWith(7, reject);
  });

  it("holds flagged content even for trusted teams", async () => {
    mockScreen.mockResolvedValue(hold);
    const decision = await gateOutgoingEmail({
      email,
      attachments: [],
      isBulk: true,
      unsubUrl: "https://mail.scribase.com/unsubscribe?id=1",
      now,
    });
    expect(decision).toBe("held");
    expect(mockDb.emailReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailId: "em_1" },
        create: expect.objectContaining({
          reason: "CONTENT",
          teamId: 7,
          isBulk: true,
          unsubUrl: "https://mail.scribase.com/unsubscribe?id=1",
        }),
      }),
    );
    expect(mockDb.email.update).toHaveBeenCalledWith({
      where: { id: "em_1" },
      data: { latestStatus: "HELD" },
    });
    expect(mockDb.emailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "HELD",
        data: expect.objectContaining({ reason: "CONTENT" }),
      }),
    });
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      expect.stringContaining("3 email(s) waiting for review"),
      expect.stringContaining("/admin/review"),
    );
  });

  it("holds a new team's first sends", async () => {
    mockScreen.mockResolvedValue(allow);
    mockTeam.current = newTeam();
    const decision = await gateOutgoingEmail({
      email,
      attachments: [],
      isBulk: false,
      now,
    });
    expect(decision).toBe("held");
    expect(mockDb.emailReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: "FIRST_SENDS" }),
      }),
    );
  });

  it("rate-limits admin notifications", async () => {
    mockScreen.mockResolvedValue(hold);
    mockRedis.set.mockResolvedValue(null);
    await gateOutgoingEmail({ email, attachments: [], isBulk: false, now });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it("treats campaign mail and Precedence: bulk as marketing", async () => {
    mockScreen.mockResolvedValue(allow);
    await gateOutgoingEmail({
      email: { ...email, campaignId: "c1" },
      attachments: [{ filename: "a.pdf" }],
      isBulk: false,
      now,
    });
    expect(mockScreen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isMarketing: true,
        attachments: [{ filename: "a.pdf" }],
      }),
    );
    await gateOutgoingEmail({
      email,
      attachments: [],
      headers: { Precedence: "bulk", "list-unsubscribe": "<https://x>" },
      isBulk: false,
      now,
    });
    expect(mockScreen).toHaveBeenLastCalledWith(
      expect.objectContaining({ isMarketing: true, hasListUnsubscribe: true }),
    );
  });
});

describe("needsFirstSendsReview", () => {
  beforeEach(() => {
    mockEnv.NEXT_PUBLIC_IS_CLOUD = true;
    mockEnv.FIRST_SENDS_REVIEW_EMAILS = undefined;
    mockEnv.FIRST_SENDS_REVIEW_HOURS = undefined;
  });

  it("is off outside cloud mode", async () => {
    mockEnv.NEXT_PUBLIC_IS_CLOUD = false;
    mockTeam.current = newTeam();
    expect(await needsFirstSendsReview(7, now)).toBe(false);
  });

  it("is skipped for verified or trusted teams without counting", async () => {
    mockTeam.current = { ...newTeam(), isVerified: true };
    expect(await needsFirstSendsReview(7, now)).toBe(false);
    mockTeam.current = trustedTeam();
    expect(await needsFirstSendsReview(7, now)).toBe(false);
    expect(mockDb.dailyEmailUsage.aggregate).not.toHaveBeenCalled();
  });

  it("graduates a team that has sent enough and is old enough", async () => {
    mockTeam.current = {
      ...newTeam(),
      createdAt: new Date(now.getTime() - 72 * HOUR_MS).toISOString(),
    };
    mockDb.dailyEmailUsage.aggregate.mockResolvedValue({ _sum: { sent: 25 } });
    expect(await needsFirstSendsReview(7, now)).toBe(false);
    expect(mockDb.team.updateMany).toHaveBeenCalledWith({
      where: { id: 7, sendingTrustedAt: null },
      data: { sendingTrustedAt: now },
    });
    expect(mockInvalidate).toHaveBeenCalledWith(7);
  });

  it("honours env overrides (0/0 disables the review)", async () => {
    mockEnv.FIRST_SENDS_REVIEW_EMAILS = 0;
    mockEnv.FIRST_SENDS_REVIEW_HOURS = 0;
    mockTeam.current = newTeam();
    mockDb.dailyEmailUsage.aggregate.mockResolvedValue({ _sum: { sent: 0 } });
    expect(await needsFirstSendsReview(7, now)).toBe(false);
  });
});
