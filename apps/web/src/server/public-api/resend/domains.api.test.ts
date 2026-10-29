/**
 * Resend-compat PATCH /domains/:id tracking_subdomain.
 * Runs through the real Hono app with mocked domain persistence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetTeamFromToken, mockRedis, mockDb, mockDomainService } =
  vi.hoisted(() => ({
    mockGetTeamFromToken: vi.fn(),
    mockRedis: {
      incr: vi.fn(),
      expire: vi.fn(),
      ttl: vi.fn(),
    },
    mockDb: {
      domain: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
    mockDomainService: {
      createDomain: vi.fn(),
      getDomain: vi.fn(),
      getDomains: vi.fn(),
      updateDomain: vi.fn(),
      deleteDomain: vi.fn(),
      refreshDomainVerification: vi.fn(),
    },
  }));

vi.mock("~/server/public-api/auth", () => ({
  getTeamFromToken: mockGetTeamFromToken,
}));
vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
  BULL_PREFIX: "bull",
}));
vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/utils/common", () => ({ isSelfHosted: () => false }));
vi.mock("~/server/service/domain-service", () => mockDomainService);
vi.mock("~/server/service/limit-service", () => ({
  LimitService: { checkWebhookLimit: vi.fn() },
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/server/public-api/request-log-middleware", () => ({
  requestLogMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("~/server/mailer", () => ({ sendMail: vi.fn() }));
vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: { queueEmail: vi.fn() },
}));
vi.mock("~/server/service/email-service", () => ({
  sendEmail: vi.fn(),
}));
vi.mock("~/server/provider", () => ({
  getEmailProvider: vi.fn(),
  getProviderRegion: vi.fn(),
}));
vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: {
    createWebhook: vi.fn(),
    listWebhooks: vi.fn(),
    getWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    rotateSigningSecret: vi.fn(),
    listWebhookCalls: vi.fn(),
  },
}));
vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: {
    getSuppressionList: vi.fn(),
    addSuppression: vi.fn(),
    removeSuppression: vi.fn(),
  },
}));

import { buildResendApp } from "~/server/public-api/resend";

const BASE_URL = "https://api.mail.scribase.test";

function useServer() {
  const app = buildResendApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const rewritten = new URL(
      `/api/resend${url.pathname}${url.search}`,
      "http://localhost",
    );
    return app.fetch(new Request(rewritten, request));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

const TEAM = {
  id: 1,
  apiRateLimit: 10,
  apiKeyId: 10,
  apiKey: { domainId: null, permission: "FULL" },
};

function storedDomain() {
  return {
    id: 4,
    name: "acme.test",
    status: "SUCCESS",
    isVerifying: false,
    createdAt: new Date("2026-10-07T12:00:00.000Z"),
    region: "eu-frankfurt-1",
    openTracking: true,
    clickTracking: false,
    tlsMode: "OPPORTUNISTIC",
    trackingSubdomain: "links",
    dnsRecords: [
      {
        type: "CNAME",
        name: "links",
        value: "mail.scribase.com",
        ttl: "Auto",
        status: "NOT_STARTED",
      },
    ],
  };
}

describe("PATCH /domains/:id tracking_subdomain", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockDb.domain.findFirst.mockResolvedValue({ id: 4 });
    mockDomainService.updateDomain.mockResolvedValue(storedDomain());
    mockDomainService.getDomain.mockResolvedValue(storedDomain());
  });

  afterEach(() => restore());

  async function patch(body: unknown) {
    return fetch(`${BASE_URL}/domains/4`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer sm_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("saves a tracking label and returns it with the CNAME record", async () => {
    const res = await patch({ tracking_subdomain: "Links" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tracking_subdomain).toBe("links");
    expect(body.open_tracking).toBe(true);
    expect(body.records[0]).toMatchObject({
      record: "Tracking",
      name: "links",
      type: "CNAME",
      value: "mail.scribase.com",
    });
    expect(mockDomainService.updateDomain).toHaveBeenCalledWith(4, {
      trackingSubdomain: "links",
    });
  });

  it("rejects clearing the label and rejects a hostname instead of a label", async () => {
    const cleared = await patch({ tracking_subdomain: null });
    expect(cleared.status).toBe(422);
    const clearedBody = await cleared.json();
    expect(clearedBody.message).toMatch(/cannot be removed/);

    const hostname = await patch({ tracking_subdomain: "links.acme.test" });
    expect(hostname.status).toBe(422);
    const hostnameBody = await hostname.json();
    expect(hostnameBody.message).toMatch(/single DNS label/);
    expect(mockDomainService.updateDomain).not.toHaveBeenCalled();
  });

  it("still rejects unknown domain fields", async () => {
    const res = await patch({ custom_tracking_domain: "links.acme.test" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).toMatch(/Unsupported field/);
    expect(mockDomainService.updateDomain).not.toHaveBeenCalled();
  });
});
