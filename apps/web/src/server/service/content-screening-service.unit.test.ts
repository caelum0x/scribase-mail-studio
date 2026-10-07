import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, mockRedis, mockDb, mockSendMail, mockInvalidate, mockIndex } =
  vi.hoisted(() => ({
    mockEnv: {
      CONTENT_SCREENING_ENABLED: true,
      NEXTAUTH_URL: "https://mail.scribase.com",
      ADMIN_EMAIL: "admin@scribase.com" as string | undefined,
      SCREENING_ALLOWLIST_DOMAINS: undefined as string | undefined,
      SCREENING_BLOCKED_DOMAINS: "banned.test" as string | undefined,
    },
    mockRedis: { incr: vi.fn(), expire: vi.fn() },
    mockDb: { team: { updateMany: vi.fn() } },
    mockSendMail: vi.fn(),
    mockInvalidate: vi.fn(),
    mockIndex: { isListed: vi.fn() },
  }));

vi.mock("~/env", () => ({ env: mockEnv }));
vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/mailer", () => ({ sendMail: mockSendMail }));
vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (k: string) => k,
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/server/screening/threat-feed-store", () => ({
  getThreatIndex: async () => mockIndex,
  parseListEnv: (v?: string) => (v ? v.split(",") : []),
}));
vi.mock("./team-service", () => ({
  TeamService: { invalidateTeamCache: mockInvalidate },
}));

import { ContentScreeningService } from "./content-screening-service";
import { SCREENING_POLICY } from "~/lib/constants/sending-policy";

const clean = {
  subject: "Receipt",
  html: '<a href="https://shop.example.com">Order</a>',
  isMarketing: false,
  hasListUnsubscribe: false,
};
const malicious = {
  ...clean,
  html: '<a href="https://evil.test/login">Log in</a>',
};

describe("ContentScreeningService", () => {
  beforeEach(() => {
    mockEnv.CONTENT_SCREENING_ENABLED = true;
    mockIndex.isListed.mockImplementation((h: string) => h === "evil.test");
    mockDb.team.updateMany.mockResolvedValue({ count: 1 });
  });

  it("allows everything when screening is disabled", async () => {
    mockEnv.CONTENT_SCREENING_ENABLED = false;
    const verdict = await ContentScreeningService.screen(malicious);
    expect(verdict.action).toBe("allow");
  });

  it("uses the threat index and the blocked-domain env list", async () => {
    expect((await ContentScreeningService.screen(malicious)).action).toBe(
      "reject",
    );
    expect(
      (
        await ContentScreeningService.screen({
          ...clean,
          html: '<a href="https://banned.test/">x</a>',
        })
      ).action,
    ).toBe("reject");
    expect((await ContentScreeningService.screen(clean)).action).toBe("allow");
  });

  it("assertSendable throws a clear API error and records a strike", async () => {
    mockRedis.incr.mockResolvedValue(1);
    await expect(
      ContentScreeningService.assertSendable(7, malicious),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(
        "Email rejected by content screening: Link to a known phishing or malware host (evil.test)",
      ),
    });
    expect(mockRedis.incr).toHaveBeenCalledWith("screening:strikes:7");
    expect(mockRedis.expire).toHaveBeenCalled();
    expect(mockDb.team.updateMany).not.toHaveBeenCalled();
  });

  it("assertSendable lets clean and held content through", async () => {
    await expect(
      ContentScreeningService.assertSendable(7, clean),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      ContentScreeningService.assertSendable(7, {
        ...clean,
        html: '<a href="https://bit.ly/x">x</a>',
      }),
    ).resolves.toMatchObject({ action: "hold" });
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it("blocks the team on repeated strikes and notifies the admin", async () => {
    mockRedis.incr.mockResolvedValue(SCREENING_POLICY.strikesToBlock);
    const verdict = await ContentScreeningService.screen(malicious);
    const result = await ContentScreeningService.recordStrike(
      7,
      verdict,
      new Date("2026-10-07T00:00:00Z"),
    );
    expect(result).toEqual({
      strikes: SCREENING_POLICY.strikesToBlock,
      blocked: true,
    });
    expect(mockDb.team.updateMany).toHaveBeenCalledWith({
      where: { id: 7, isBlocked: false },
      data: expect.objectContaining({
        isBlocked: true,
        blockedReason: expect.stringMatching(/^CONTENT: /),
      }),
    });
    expect(mockInvalidate).toHaveBeenCalledWith(7);
    expect(mockSendMail).toHaveBeenCalledWith(
      "admin@scribase.com",
      expect.stringContaining("team 7 blocked"),
      expect.any(String),
      expect.any(String),
    );
  });

  it("does not re-notify when the team was already blocked", async () => {
    mockRedis.incr.mockResolvedValue(SCREENING_POLICY.strikesToBlock + 1);
    mockDb.team.updateMany.mockResolvedValue({ count: 0 });
    const verdict = await ContentScreeningService.screen(malicious);
    await ContentScreeningService.recordStrike(7, verdict);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
