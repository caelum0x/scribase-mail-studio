/**
 * API tests for the Resend-compatible public webhooks API.
 * Runs through the real Hono app with mocked WebhookService / auth / redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetTeamFromToken,
  mockRedis,
  mockDb,
  mockLimitService,
  mockWebhookService,
} = vi.hoisted(() => ({
  mockGetTeamFromToken: vi.fn(),
  mockRedis: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  },
  mockDb: {
    domain: {
      findMany: vi.fn(),
    },
  },
  mockLimitService: {
    checkWebhookLimit: vi.fn(),
  },
  mockWebhookService: {
    createWebhook: vi.fn(),
    listWebhooks: vi.fn(),
    getWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    rotateSigningSecret: vi.fn(),
    listWebhookCalls: vi.fn(),
  },
}));

vi.mock("~/server/public-api/auth", () => ({ getTeamFromToken: mockGetTeamFromToken }));
vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
  BULL_PREFIX: "bull",
}));
vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/utils/common", () => ({ isSelfHosted: () => false }));
vi.mock("~/server/service/limit-service", () => ({
  LimitService: mockLimitService,
}));
vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: mockWebhookService,
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Suppress request log writes in tests
vi.mock("~/server/public-api/request-log-middleware", () => ({
  requestLogMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
// Prevent resolution of heavy/unbuilt packages
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
vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: { getSuppressionList: vi.fn(), addSuppression: vi.fn(), removeSuppression: vi.fn() },
}));

import { HTTPException } from "hono/http-exception";
import { buildResendApp } from "~/server/public-api/resend";

const BASE_URL = "https://api.mail.scribase.test";

function useServer() {
  const app = buildResendApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const rewritten = new URL(`/api/resend${url.pathname}${url.search}`, "http://localhost");
    return app.fetch(new Request(rewritten, request));
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

const DEFAULT_TEAM = {
  id: 1,
  apiRateLimit: 10,
  apiKeyId: 10,
  apiKey: { domainId: null, permission: "FULL" },
};

const NOW = new Date("2026-10-07T12:00:00.000Z");

const SAMPLE_WEBHOOK = {
  id: "wh_1",
  teamId: 1,
  url: "https://example.com/hook",
  description: "Test",
  secret: "whsec_abc123",
  eventTypes: ["email.sent"],
  status: "ACTIVE",
  signatureFormat: "SVIX",
  domainIds: [],
  apiVersion: null,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  createdByUserId: null,
  previousSecret: null,
  previousSecretExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("POST /webhooks", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockLimitService.checkWebhookLimit.mockResolvedValue({ isLimitReached: false });
    mockDb.domain.findMany.mockResolvedValue([]);
    mockWebhookService.createWebhook.mockResolvedValue(SAMPLE_WEBHOOK);
  });

  afterEach(() => restore());

  it("creates a webhook", async () => {
    const res = await fetch(`${BASE_URL}/webhooks`, {
      method: "POST",
      headers: { Authorization: "Bearer us_key", "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook", events: ["email.sent"] }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("webhook");
    expect(body.id).toBe("wh_1");
    expect(body.events).toEqual(["email.sent"]);
    expect(mockWebhookService.createWebhook).toHaveBeenCalledOnce();
  });

  it("returns 4xx for missing url", async () => {
    const res = await fetch(`${BASE_URL}/webhooks`, {
      method: "POST",
      headers: { Authorization: "Bearer us_key", "Content-Type": "application/json" },
      body: JSON.stringify({ events: ["email.sent"] }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("returns validation_error for invalid url", async () => {
    const res = await fetch(`${BASE_URL}/webhooks`, {
      method: "POST",
      headers: { Authorization: "Bearer us_key", "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });

    expect(res.status).toBe(422);
  });
});

describe("GET /webhooks", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockWebhookService.listWebhooks.mockResolvedValue([SAMPLE_WEBHOOK]);
  });

  afterEach(() => restore());

  it("lists webhooks", async () => {
    const res = await fetch(`${BASE_URL}/webhooks`, {
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("wh_1");
  });
});

describe("GET /webhooks/:id", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockWebhookService.getWebhook.mockResolvedValue(SAMPLE_WEBHOOK);
  });

  afterEach(() => restore());

  it("returns a single webhook", async () => {
    const res = await fetch(`${BASE_URL}/webhooks/wh_1`, {
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("wh_1");
    expect(body.signing_secret).toBe("whsec_abc123");
  });

  it("returns 404 for unknown webhook", async () => {
    mockWebhookService.getWebhook.mockRejectedValue(
      new HTTPException(404, { message: "Webhook not found" }),
    );

    const res = await fetch(`${BASE_URL}/webhooks/wh_missing`, {
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.name).toBe("not_found");
  });
});

describe("DELETE /webhooks/:id", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockWebhookService.getWebhook.mockResolvedValue(SAMPLE_WEBHOOK);
    mockWebhookService.deleteWebhook.mockResolvedValue(undefined);
  });

  afterEach(() => restore());

  it("deletes a webhook", async () => {
    const res = await fetch(`${BASE_URL}/webhooks/wh_1`, {
      method: "DELETE",
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(mockWebhookService.deleteWebhook).toHaveBeenCalledOnce();
  });
});

describe("POST /webhooks/:id/signing-secret/rotate", () => {
  let restore: () => void;

  const ROTATED_WEBHOOK = {
    ...SAMPLE_WEBHOOK,
    secret: "whsec_newSecret",
    previousSecret: "whsec_abc123",
  };

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockWebhookService.rotateSigningSecret.mockResolvedValue(ROTATED_WEBHOOK);
  });

  afterEach(() => restore());

  it("rotates the signing secret", async () => {
    const res = await fetch(`${BASE_URL}/webhooks/wh_1/signing-secret/rotate`, {
      method: "POST",
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("webhook_signing_secret");
    expect(body.signing_secret).toBe("whsec_newSecret");
    expect(body.webhook_id).toBe("wh_1");
    expect(mockWebhookService.rotateSigningSecret).toHaveBeenCalledWith({
      id: "wh_1",
      teamId: DEFAULT_TEAM.id,
    });
  });
});
