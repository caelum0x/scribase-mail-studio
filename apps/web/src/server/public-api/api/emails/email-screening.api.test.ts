import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetTeamFromToken,
  mockRedis,
  mockDb,
  mockQueueEmail,
  mockCheckSuppression,
} = vi.hoisted(() => ({
  mockGetTeamFromToken: vi.fn(),
  mockRedis: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
  mockDb: {
    apiKey: { findUnique: vi.fn() },
    email: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    emailEvent: { create: vi.fn() },
    team: { updateMany: vi.fn() },
  },
  mockQueueEmail: vi.fn(),
  mockCheckSuppression: vi.fn(),
}));

vi.mock("~/server/public-api/auth", () => ({
  getTeamFromToken: mockGetTeamFromToken,
}));
vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
}));
vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/utils/common", () => ({
  isSelfHosted: () => false,
  isCloud: () => true,
}));
vi.mock("~/server/service/domain-service", () => ({
  validateApiKeyDomainAccess: vi.fn(async () => ({
    id: 3,
    name: "acme.test",
    region: "eu-frankfurt-1",
  })),
  validateDomainFromEmail: vi.fn(),
}));
vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: { checkMultipleEmails: mockCheckSuppression },
}));
vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: { queueEmail: mockQueueEmail },
}));
vi.mock("~/server/mailer", () => ({ sendMail: vi.fn() }));
vi.mock("~/server/screening/threat-feed-store", () => ({
  // The real ThreatIndex also matches subdomains of listed hosts.
  getThreatIndex: async () => ({
    isListed: (host: string) =>
      host === "evil.test" || host.endsWith(".evil.test"),
  }),
  parseListEnv: () => [],
}));

import { getApp } from "~/server/public-api/hono";
import sendEmailRoute from "~/server/public-api/api/emails/send-email";
import getEmailRoute from "~/server/public-api/api/emails/get-email";

function post(body: Record<string, unknown>) {
  const app = getApp();
  sendEmailRoute(app);
  return app.request("http://localhost/api/v1/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("content screening on the public API", () => {
  beforeEach(() => {
    mockGetTeamFromToken.mockResolvedValue({
      id: 1,
      apiRateLimit: 20,
      apiKeyId: 11,
      apiKey: { domainId: null },
    });
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockDb.apiKey.findUnique.mockResolvedValue({ id: 11, domain: null });
    mockCheckSuppression.mockResolvedValue({});
    mockDb.email.create.mockResolvedValue({ id: "em_1" });
  });

  it("rejects an email linking to a known phishing host with a clear 400", async () => {
    const response = await post({
      from: "hello@acme.test",
      to: "user@example.com",
      subject: "Your account",
      html: '<a href="https://login.evil.test/x">Sign in</a>',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Email rejected by content screening");
    expect(body.error.message).toContain("login.evil.test");
    expect(mockDb.email.create).not.toHaveBeenCalled();
    expect(mockQueueEmail).not.toHaveBeenCalled();
  });

  it("rejects dangerous attachments", async () => {
    const response = await post({
      from: "hello@acme.test",
      to: "user@example.com",
      subject: "Invoice",
      text: "See attached",
      attachments: [{ filename: "invoice.pdf.exe", content: "AAAA" }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain(
      "Attachment type .exe is not allowed",
    );
  });

  it("accepts clean email and queues it", async () => {
    const response = await post({
      from: "hello@acme.test",
      to: "user@example.com",
      subject: "Receipt",
      html: '<p>Thanks</p><a href="https://acme.test/orders/1">Order</a>',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ emailId: "em_1" });
    expect(mockQueueEmail).toHaveBeenCalled();
  });

  it("GET returns HELD as latestStatus", async () => {
    mockDb.email.findUnique.mockResolvedValue({
      id: "em_1",
      teamId: 1,
      to: ["user@example.com"],
      from: "hello@acme.test",
      subject: "Hi",
      html: null,
      text: "Hi",
      latestStatus: "HELD",
      createdAt: new Date("2026-10-07T00:00:00Z"),
      updatedAt: new Date("2026-10-07T00:00:00Z"),
      emailEvents: [
        {
          emailId: "em_1",
          status: "HELD",
          createdAt: new Date("2026-10-07T00:00:00Z"),
          data: { reason: "FIRST_SENDS" },
        },
      ],
    });
    const app = getApp();
    getEmailRoute(app);
    const response = await app.request("http://localhost/api/v1/emails/em_1", {
      headers: { Authorization: "Bearer test-key" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.latestStatus).toBe("HELD");
    expect(body.emailEvents[0].status).toBe("HELD");
  });
});
