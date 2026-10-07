/**
 * Unit tests for the received emails endpoints in the Resend-compat API.
 * All Prisma and OCI dependencies are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetTeamFromToken, mockRedis, mockDb } = vi.hoisted(() => ({
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
    receivedEmail: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    receivedEmailAttachment: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("~/server/public-api/auth", () => ({ getTeamFromToken: mockGetTeamFromToken }));
vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (k: string) => k,
}));
vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/utils/common", () => ({ isSelfHosted: () => false }));
vi.mock("~/server/service/inbound-storage-service", () => ({
  getStorageSignedDownloadUrl: vi.fn().mockResolvedValue("https://storage.example.com/signed-url"),
}));

import { buildResendApp } from "~/server/public-api/resend";

const BASE_URL = "https://api.mail.scribase.test";
const PREFIX = "/api/resend";

const TEAM = {
  id: 1,
  apiKey: { permission: "FULL", domainId: null },
  apiKeyId: 1,
};

const RECEIVED_EMAIL = {
  id: "rec_abc123",
  from: "sender@example.com",
  to: ["inbox@acme.dev"],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Hello inbound",
  text: "Hello",
  html: "<p>Hello</p>",
  headers: null,
  rawStorageKey: "inbound/raw/test.eml",
  sizeBytes: 1024,
  spfResult: "pass",
  dkimResult: "pass",
  dmarcResult: "pass",
  spamScore: null,
  createdAt: new Date("2026-10-07T12:00:00Z"),
  domainId: 7,
  attachments: [],
};

function buildFetch() {
  const app = buildResendApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const rewritten = new URL(`${PREFIX}${url.pathname}${url.search}`, "http://localhost");
    return app.fetch(
      new Request(rewritten.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.method !== "GET" ? await request.text() : undefined,
      }),
    );
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe("GET /emails/received", () => {
  let cleanup: () => void;

  beforeEach(() => {
    mockGetTeamFromToken.mockResolvedValue(TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(-1);
    cleanup = buildFetch();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("returns a list of received emails", async () => {
    mockDb.receivedEmail.findMany.mockResolvedValue([RECEIVED_EMAIL]);

    const res = await fetch(`${BASE_URL}/emails/received`, {
      headers: { Authorization: "Bearer re_test_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0]!.id).toBe("rec_abc123");
    expect(data[0]!.spf_result).toBe("pass");
    expect(data[0]!.object).toBe("received_email");
  });

  it("returns empty list when no received emails", async () => {
    mockDb.receivedEmail.findMany.mockResolvedValue([]);

    const res = await fetch(`${BASE_URL}/emails/received`, {
      headers: { Authorization: "Bearer re_test_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.data as unknown[]).length).toBe(0);
    expect(body.has_more).toBe(false);
  });
});

describe("GET /emails/received/:id", () => {
  let cleanup: () => void;

  beforeEach(() => {
    mockGetTeamFromToken.mockResolvedValue(TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(-1);
    cleanup = buildFetch();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("returns the received email", async () => {
    mockDb.receivedEmail.findFirst.mockResolvedValue(RECEIVED_EMAIL);

    const res = await fetch(`${BASE_URL}/emails/received/rec_abc123`, {
      headers: { Authorization: "Bearer re_test_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe("rec_abc123");
    expect(body.subject).toBe("Hello inbound");
    expect(body.from).toBe("sender@example.com");
  });

  it("returns 404 when not found", async () => {
    mockDb.receivedEmail.findFirst.mockResolvedValue(null);

    const res = await fetch(`${BASE_URL}/emails/received/unknown`, {
      headers: { Authorization: "Bearer re_test_key" },
    });

    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe("not_found");
  });

  it("returns 401 without API key", async () => {
    const res = await fetch(`${BASE_URL}/emails/received/rec_abc123`);
    expect(res.status).toBe(401);
  });
});

describe("GET /emails/received/:id/attachments", () => {
  let cleanup: () => void;

  beforeEach(() => {
    mockGetTeamFromToken.mockResolvedValue(TEAM);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(-1);
    cleanup = buildFetch();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("returns attachments with download URLs", async () => {
    mockDb.receivedEmail.findFirst.mockResolvedValue({
      id: "rec_abc123",
      attachments: [
        {
          id: "att_1",
          filename: "invoice.pdf",
          contentType: "application/pdf",
          contentId: null,
          contentDisposition: "attachment",
          sizeBytes: 5000,
          storageKey: "inbound/attachments/invoice.pdf",
          createdAt: new Date("2026-10-07T12:01:00Z"),
        },
      ],
    });

    const res = await fetch(`${BASE_URL}/emails/received/rec_abc123/attachments`, {
      headers: { Authorization: "Bearer re_test_key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const data = body.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0]!.filename).toBe("invoice.pdf");
    expect(data[0]!.download_url).toBe("https://storage.example.com/signed-url");
  });
});
