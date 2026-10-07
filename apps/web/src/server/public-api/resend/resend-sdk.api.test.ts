/**
 * Acceptance test: the official `resend` npm SDK, pointed at our
 * Resend-compatible API with only `baseUrl` changed, can send, schedule and
 * retrieve emails. Requests run through the real Hono app, auth/permission/
 * rate-limit middleware, the Resend schema mapping and the real
 * `sendEmail` service; only Prisma, Redis, the BullMQ queue and the
 * suppression lookup are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Resend } from "resend";

const { mockGetTeamFromToken, mockRedis, mockDb, mockQueueEmail, mockSuppression } =
  vi.hoisted(() => ({
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
      apiKey: { findUnique: vi.fn() },
      domain: { findFirst: vi.fn() },
      template: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      templateVersion: { findFirst: vi.fn(), create: vi.fn() },
      email: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      emailEvent: { create: vi.fn() },
      emailAttachment: { findMany: vi.fn(), findFirst: vi.fn() },
      emailShare: { create: vi.fn(), findUnique: vi.fn() },
      contact: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
      contactBook: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
      contactProperty: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      topic: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      contactTopic: { findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
      segment: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      segmentContact: { createMany: vi.fn(), deleteMany: vi.fn() },
      campaign: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
      campaignEmail: { deleteMany: vi.fn() },
    },
    mockQueueEmail: vi.fn(),
    mockSuppression: vi.fn(),
  }));

vi.mock("~/server/public-api/auth", () => ({ getTeamFromToken: mockGetTeamFromToken }));
vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
  BULL_PREFIX: "bull",
}));
vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/utils/common", () => ({ isSelfHosted: () => false }));
vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: { queueEmail: mockQueueEmail },
}));
vi.mock("~/server/mailer", () => ({ sendMail: vi.fn() }));
vi.mock("~/server/service/webhook-service", () => ({ WebhookService: { emit: vi.fn() } }));
vi.mock("~/server/service/limit-service", () => ({
  LimitService: { checkContactBookLimit: vi.fn().mockResolvedValue({ isLimitReached: false }) },
}));
vi.mock("~/server/provider", () => ({
  getEmailProvider: vi.fn(),
  getProviderRegion: vi.fn(),
}));
vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: { checkMultipleEmails: mockSuppression },
}));
vi.mock("~/server/service/contact-queue-service", () => ({
  ContactQueueService: { addBulkContactJobs: vi.fn() },
}));
vi.mock("~/server/service/double-opt-in-service", () => ({
  sendDoubleOptInConfirmationEmail: vi.fn(),
}));
vi.mock("~/server/service/content-screening-service", () => ({
  ContentScreeningService: { assertSendable: vi.fn() },
}));
vi.mock("~/server/service/storage-service", () => ({
  isStorageConfigured: vi.fn().mockReturnValue(false),
  getStoragePublicUrl: vi.fn((key: string) => `https://storage.test/${key}`),
  getDocumentUploadUrl: vi.fn(),
}));
vi.mock("~/server/service/dashboard-service", () => ({
  emailTimeSeries: vi.fn().mockResolvedValue({ result: [], totalCounts: {} }),
  reputationMetricsData: vi.fn().mockResolvedValue({}),
}));
vi.mock("~/lib/contact-properties", () => ({
  normalizeContactProperties: (p: Record<string, string>) => p,
  mergeContactProperties: (_e: unknown, incoming: unknown) => incoming,
}));
vi.mock("~/server/service/contact-variable-service", () => ({
  normalizeContactBookVariables: (v: string[]) => v ?? [],
  validateContactBookVariables: vi.fn(),
}));
vi.mock("~/lib/constants/double-opt-in", () => ({
  DEFAULT_DOUBLE_OPT_IN_CONTENT: "confirm",
  DEFAULT_DOUBLE_OPT_IN_SUBJECT: "Confirm",
  hasDoubleOptInUrlPlaceholder: vi.fn().mockReturnValue(true),
}));
vi.mock("~/server/service/campaign-service", async (importOriginal) => {
  const orig = await importOriginal<typeof import("~/server/service/campaign-service")>();
  return {
    ...orig,
    createCampaignFromApi: vi.fn(),
    sendCampaign: vi.fn(),
    scheduleCampaign: vi.fn(),
    pauseCampaign: vi.fn(),
    deleteCampaign: vi.fn(),
  };
});

import { buildResendApp } from "~/server/public-api/resend";

const BASE_URL = "https://api.mail.scribase.test";
const DOMAIN = {
  id: 7,
  name: "acme.dev",
  teamId: 1,
  status: "SUCCESS",
  region: "eu-frankfurt-1",
};

type StoredEmail = Record<string, any>;

function useInProcessServer(prefix: string) {
  const app = buildResendApp();
  const realFetch = globalThis.fetch;
  const seen: Array<{ url: string; method: string; headers: Headers }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe(BASE_URL);
    // Same rewrite Caddy performs for the API host.
    const rewritten = new URL(`${prefix}${url.pathname}${url.search}`, "http://localhost");
    seen.push({ url: request.url, method: request.method, headers: request.headers });
    return app.fetch(new Request(rewritten, request));
  }) as typeof fetch;

  return {
    seen,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

describe("official resend SDK against the compat API", () => {
  let stored: StoredEmail[];
  let server: ReturnType<typeof useInProcessServer>;

  beforeEach(() => {
    stored = [];
    mockGetTeamFromToken.mockResolvedValue({
      id: 1,
      apiRateLimit: 10,
      apiKeyId: 11,
      apiKey: { domainId: null, permission: "FULL" },
    });
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.setex.mockResolvedValue("OK");
    mockRedis.del.mockResolvedValue(1);
    mockDb.apiKey.findUnique.mockResolvedValue({ id: 11, teamId: 1, domainId: null, domain: null });
    mockDb.domain.findFirst.mockResolvedValue(DOMAIN);
    mockDb.topic.findFirst.mockResolvedValue(null);
    mockSuppression.mockImplementation(async (emails: string[]) =>
      Object.fromEntries(emails.map((e) => [e, false])),
    );
    mockQueueEmail.mockResolvedValue(undefined);
    mockDb.email.create.mockImplementation(async ({ data }: { data: StoredEmail }) => {
      const row = {
        id: `em_${stored.length + 1}`,
        createdAt: new Date(Date.UTC(2026, 9, 7, 12, 0, stored.length)),
        replyTo: [],
        cc: [],
        bcc: [],
        providerMessageId: null,
        tags: null,
        topicId: null,
        scheduledAt: null,
        text: null,
        html: null,
        // Prisma ignores undefined fields; keep the column defaults.
        ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      };
      stored.push(row);
      return row;
    });
    mockDb.email.findFirst.mockImplementation(async ({ where }: { where: StoredEmail }) => {
      return stored.find((e) => e.id === where.id && e.teamId === where.teamId) ?? null;
    });
    server = useInProcessServer("/api/resend");
  });

  afterEach(() => {
    server.restore();
  });

  const client = () => new Resend("us_client_secret", { baseUrl: BASE_URL });

  it("emails.send returns { id } and runs the native send pipeline", async () => {
    const { data, error } = await client().emails.send({
      from: "Acme <hello@acme.dev>",
      to: ["user@example.com"],
      subject: "Welcome",
      html: "<p>Hi</p>",
      replyTo: "support@acme.dev",
      cc: "cc@example.com",
      headers: { "X-Entity-Ref-ID": "123" },
      tags: [{ name: "category", value: "welcome" }],
    });

    expect(error).toBeNull();
    expect(data).toEqual({ id: "em_1" });

    const created = mockDb.email.create.mock.calls[0]![0].data;
    expect(created).toMatchObject({
      from: "Acme <hello@acme.dev>",
      to: ["user@example.com"],
      subject: "Welcome",
      html: "<p>Hi</p>",
      replyTo: ["support@acme.dev"],
      cc: ["cc@example.com"],
      teamId: 1,
      domainId: 7,
      apiId: 11,
      latestStatus: "QUEUED",
      tags: [{ name: "category", value: "welcome" }],
    });
    expect(JSON.parse(created.headers)).toEqual({ "X-Entity-Ref-ID": "123" });
    expect(mockQueueEmail).toHaveBeenCalledWith("em_1", 1, "eu-frankfurt-1", true, undefined, undefined);

    // The SDK authenticated with a Bearer token.
    expect(server.seen[0]!.headers.get("authorization")).toBe("Bearer us_client_secret");
    expect(server.seen[0]!.url).toBe(`${BASE_URL}/emails`);
  });

  it("emails.get returns the Resend email object", async () => {
    const sent = await client().emails.send({
      from: "hello@acme.dev",
      to: "user@example.com",
      subject: "Receipt",
      text: "Thanks",
      tags: [{ name: "kind", value: "receipt" }],
    });
    const { data, error } = await client().emails.get(sent.data!.id);

    expect(error).toBeNull();
    expect(data).toEqual({
      object: "email",
      id: "em_1",
      from: "hello@acme.dev",
      to: ["user@example.com"],
      cc: null,
      bcc: null,
      reply_to: null,
      subject: "Receipt",
      html: null,
      text: "Thanks",
      created_at: "2026-10-07T12:00:00.000Z",
      scheduled_at: null,
      last_event: "queued",
      message_id: null,
      tags: [{ name: "kind", value: "receipt" }],
      topic_id: null,
    });
  });

  it("scheduledAt (natural language) schedules instead of sending now", async () => {
    const before = Date.now();
    const { data, error } = await client().emails.send({
      from: "hello@acme.dev",
      to: "user@example.com",
      subject: "Later",
      text: "Scheduled",
      scheduledAt: "in 1 hour",
    });

    expect(error).toBeNull();
    expect(data?.id).toBe("em_1");
    const created = mockDb.email.create.mock.calls[0]![0].data;
    expect(created.latestStatus).toBe("SCHEDULED");
    const delay = mockQueueEmail.mock.calls[0]![5] as number;
    expect(delay).toBeGreaterThan(59 * 60 * 1000 - (Date.now() - before));
    expect(delay).toBeLessThanOrEqual(60 * 60 * 1000);

    const fetched = await client().emails.get("em_1");
    expect(fetched.data?.last_event).toBe("scheduled");
    expect(fetched.data?.scheduled_at).toBe(created.scheduledAt.toISOString());
  });

  it("works with a path-prefix base URL as well", async () => {
    server.restore();
    server = useInProcessServer("");
    const resend = new Resend("us_client_secret", { baseUrl: `${BASE_URL}/api/resend` });
    const { data, error } = await resend.emails.send({
      from: "hello@acme.dev",
      to: "user@example.com",
      subject: "Hi",
      text: "Hi",
    });
    expect(error).toBeNull();
    expect(data?.id).toBe("em_1");
  });

  it("rejects unknown topic_id with not_found and accepts inline CID attachments", async () => {
    // topic_id is now supported; unknown topic → 404 not_found.
    const { data, error } = await client().emails.send({
      from: "hello@acme.dev",
      to: "user@example.com",
      subject: "Hi",
      text: "Hi",
      topicId: "topic_1",
    });
    expect(data).toBeNull();
    expect(error).toMatchObject({
      statusCode: 404,
      name: "not_found",
      message: "Topic 'topic_1' not found.",
    });

    // content_id (CID) attachments are now supported.
    const inline = await client().emails.send({
      from: "hello@acme.dev",
      to: "user@example.com",
      subject: "Hi",
      html: '<img src="cid:logo">',
      attachments: [{ filename: "logo.png", content: "aGVsbG8=", contentId: "logo" }],
    });
    expect(inline.error).toBeNull();
    expect(inline.data?.id).toBe("em_1");
    const created = mockDb.email.create.mock.calls[0]![0].data;
    expect(JSON.parse(created.attachments)).toEqual([
      { filename: "logo.png", content: "aGVsbG8=", cid: "logo" },
    ]);
  });

  it("returns missing_required_field in the Resend error shape", async () => {
    const { error } = await client().emails.send({
      from: "hello@acme.dev",
      subject: "Hi",
      text: "Hi",
    } as never);
    expect(error).toEqual({
      statusCode: 422,
      name: "missing_required_field",
      message: "Missing `to` field.",
    });
  });

  it("returns not_found for unknown emails", async () => {
    const { data, error } = await client().emails.get("em_missing");
    expect(data).toBeNull();
    expect(error).toEqual({ statusCode: 404, name: "not_found", message: "Email not found" });
  });

  it("sending-only keys can send but get restricted_api_key on reads", async () => {
    mockGetTeamFromToken.mockResolvedValue({
      id: 1,
      apiRateLimit: 10,
      apiKeyId: 11,
      apiKey: { domainId: null, permission: "SENDING" },
    });

    const sent = await client().emails.send({
      from: "hello@acme.dev",
      to: "user@example.com",
      subject: "Hi",
      text: "Hi",
    });
    expect(sent.error).toBeNull();

    const { error } = await client().emails.get(sent.data!.id);
    expect(error).toEqual({
      statusCode: 401,
      name: "restricted_api_key",
      message: "This API key is restricted to only send emails.",
    });
  });

  it("maps auth failures to missing_api_key / invalid_api_key", async () => {
    const { UnsendApiError } = await import("~/server/public-api/api-error");
    mockGetTeamFromToken.mockRejectedValue(
      new UnsendApiError({ code: "FORBIDDEN", message: "Invalid API token" }),
    );
    const { error } = await client().emails.get("em_1");
    expect(error).toEqual({ statusCode: 403, name: "invalid_api_key", message: "API key is invalid" });
  });

  it("returns rate_limit_exceeded with Resend rate-limit headers", async () => {
    mockRedis.incr.mockResolvedValue(11);
    const { error, headers } = await client().emails.get("em_1");
    expect(error).toMatchObject({ statusCode: 429, name: "rate_limit_exceeded" });
    expect(headers?.["ratelimit-limit"]).toBe("10");
    expect(headers?.["retry-after"]).toBe("1");
  });

  it("emails.list paginates with limit/after and has_more", async () => {
    const rows = [3, 2, 1].map((n) => ({
      id: `em_${n}`,
      from: "hello@acme.dev",
      to: ["user@example.com"],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: `S${n}`,
      html: null,
      text: "t",
      latestStatus: "SENT",
      scheduledAt: null,
      createdAt: new Date(Date.UTC(2026, 9, 7, 12, 0, n)),
      providerMessageId: `<em_${n}@acme.dev>`,
      tags: null,
      topicId: null,
    }));
    mockDb.email.findMany.mockImplementation(async ({ take }: { take: number }) =>
      rows.slice(0, take),
    );

    const { data, error } = await client().emails.list({ limit: 2 });
    expect(error).toBeNull();
    expect(data?.object).toBe("list");
    expect(data?.has_more).toBe(true);
    expect(data?.data.map((e) => e.id)).toEqual(["em_3", "em_2"]);
    expect(data?.data[0]).toMatchObject({ last_event: "sent", message_id: "<em_3@acme.dev>" });
    expect(data?.data[0]).not.toHaveProperty("html");
    expect(mockDb.email.findMany.mock.calls[0]![0]).toMatchObject({
      where: { teamId: 1 },
      take: 3,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });
});
