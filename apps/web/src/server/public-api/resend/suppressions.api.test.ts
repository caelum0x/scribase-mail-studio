/**
 * API tests for the Resend-compatible suppressions API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetTeamFromToken,
  mockRedis,
  mockSuppressionService,
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
  mockSuppressionService: {
    getSuppressionList: vi.fn(),
    addSuppression: vi.fn(),
    removeSuppression: vi.fn(),
  },
}));

vi.mock("~/server/public-api/auth", () => ({ getTeamFromToken: mockGetTeamFromToken }));
vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
  BULL_PREFIX: "bull",
}));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/utils/common", () => ({ isSelfHosted: () => false }));
vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: mockSuppressionService,
}));
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

const SAMPLE_SUPPRESSION = {
  id: "sup_1",
  email: "user@blocked.com",
  reason: "HARD_BOUNCE",
  source: null,
  createdAt: NOW,
};

describe("GET /suppressions", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockSuppressionService.getSuppressionList.mockResolvedValue({
      suppressions: [SAMPLE_SUPPRESSION],
      total: 1,
    });
  });

  afterEach(() => restore());

  it("lists suppressions", async () => {
    const res = await fetch(`${BASE_URL}/suppressions`, {
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].email).toBe("user@blocked.com");
    expect(body.data[0].reason).toBe("bounce");
    expect(body.data[0].object).toBe("suppression");
  });

  it("passes email filter to service", async () => {
    mockSuppressionService.getSuppressionList.mockResolvedValue({
      suppressions: [],
      total: 0,
    });

    const res = await fetch(`${BASE_URL}/suppressions?email=user@blocked.com`, {
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const call = mockSuppressionService.getSuppressionList.mock.calls[0]![0];
    expect(call.search).toBe("user@blocked.com");
  });

  it("passes reason filter to service", async () => {
    mockSuppressionService.getSuppressionList.mockResolvedValue({
      suppressions: [],
      total: 0,
    });

    const res = await fetch(`${BASE_URL}/suppressions?reason=complaint`, {
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const call = mockSuppressionService.getSuppressionList.mock.calls[0]![0];
    expect(call.reason).toBe("COMPLAINT");
  });
});

describe("POST /suppressions", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockSuppressionService.addSuppression.mockResolvedValue(SAMPLE_SUPPRESSION);
  });

  afterEach(() => restore());

  it("adds a suppression with manual reason by default", async () => {
    const res = await fetch(`${BASE_URL}/suppressions`, {
      method: "POST",
      headers: { Authorization: "Bearer us_key", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@blocked.com" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("suppression");
    expect(body.email).toBe("user@blocked.com");
    expect(body.reason).toBe("bounce"); // from SAMPLE_SUPPRESSION

    const addCall = mockSuppressionService.addSuppression.mock.calls[0]![0];
    expect(addCall.reason).toBe("MANUAL");
  });

  it("adds a suppression with bounce reason", async () => {
    const res = await fetch(`${BASE_URL}/suppressions`, {
      method: "POST",
      headers: { Authorization: "Bearer us_key", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@blocked.com", reason: "bounce" }),
    });

    expect(res.status).toBe(201);
    const addCall = mockSuppressionService.addSuppression.mock.calls[0]![0];
    expect(addCall.reason).toBe("HARD_BOUNCE");
  });

  it("returns 422 for invalid email", async () => {
    const res = await fetch(`${BASE_URL}/suppressions`, {
      method: "POST",
      headers: { Authorization: "Bearer us_key", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });

    expect(res.status).toBe(422);
  });
});

describe("DELETE /suppressions/:email", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useServer();
    mockGetTeamFromToken.mockResolvedValue(DEFAULT_TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockSuppressionService.removeSuppression.mockResolvedValue(undefined);
  });

  afterEach(() => restore());

  it("removes a suppression", async () => {
    const email = encodeURIComponent("user@blocked.com");
    const res = await fetch(`${BASE_URL}/suppressions/${email}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.email).toBe("user@blocked.com");

    expect(mockSuppressionService.removeSuppression).toHaveBeenCalledWith(
      "user@blocked.com",
      DEFAULT_TEAM.id,
    );
  });

  it("returns 422 for path without @", async () => {
    const res = await fetch(`${BASE_URL}/suppressions/not-email`, {
      method: "DELETE",
      headers: { Authorization: "Bearer us_key" },
    });

    expect(res.status).toBe(422);
  });
});
