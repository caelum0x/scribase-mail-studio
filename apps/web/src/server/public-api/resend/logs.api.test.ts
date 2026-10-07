/**
 * API tests for the Resend-compatible logs API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetTeamFromToken,
  mockRedis,
  mockDb,
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
    apiRequestLog: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
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
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
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
vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: {},
}));
vi.mock("~/server/provider", () => ({
  getEmailProvider: vi.fn(),
  getProviderRegion: vi.fn(),
}));
vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: { getSuppressionList: vi.fn(), addSuppression: vi.fn(), removeSuppression: vi.fn() },
}));

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

const SAMPLE_LOG = {
  id: "log_1",
  teamId: 1,
  apiKeyId: 10,
  method: "POST",
  path: "/api/resend/emails",
  statusCode: 200,
  durationMs: 42,
  userAgent: "test-agent/1.0",
  ipAddress: "1.2.3.4",
  errorName: null,
  requestBody: { from: "a@b.com" },
  responseBody: { id: "em_1" },
  createdAt: NOW,
};

describe("GET /logs", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockDb.apiRequestLog.findMany.mockResolvedValue([SAMPLE_LOG]);
    mockDb.apiRequestLog.findFirst.mockResolvedValue(null);
  });

  afterEach(() => restore());

  it("lists logs in Resend shape", async () => {
    const res = await fetch(`${BASE_URL}/logs`, {
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);

    const log = body.data[0];
    expect(log.object).toBe("log");
    expect(log.id).toBe("log_1");
    expect(log.endpoint).toBe("/api/resend/emails");
    expect(log.method).toBe("POST");
    expect(log.response_status).toBe(200);
    expect(log.duration_ms).toBe(42);
    expect(log.user_agent).toBe("test-agent/1.0");
    expect(log.ip_address).toBe("1.2.3.4");
    expect(log.created_at).toBe(NOW.toISOString());
  });

  it("scopes log query to the team", async () => {
    await fetch(`${BASE_URL}/logs`, {
      headers: { Authorization: "Bearer us_key" },
    });

    const findManyCall = mockDb.apiRequestLog.findMany.mock.calls[0]![0];
    expect(findManyCall.where).toMatchObject({ teamId: DEFAULT_TEAM.id });
  });
});

describe("GET /logs/:id", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockDb.apiRequestLog.findFirst.mockResolvedValue(SAMPLE_LOG);
  });

  afterEach(() => restore());

  it("returns a single log", async () => {
    const res = await fetch(`${BASE_URL}/logs/log_1`, {
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("log");
    expect(body.id).toBe("log_1");
  });

  it("returns 404 for missing log", async () => {
    mockDb.apiRequestLog.findFirst.mockResolvedValue(null);

    const res = await fetch(`${BASE_URL}/logs/log_missing`, {
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.name).toBe("not_found");
  });
});
