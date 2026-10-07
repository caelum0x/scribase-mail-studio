/**
 * Wave 2 acceptance tests — contacts, topics, segments, broadcasts, templates,
 * attachments, share, metrics.
 *
 * Each suite uses the real Hono app (in-process) with mocked Prisma/Redis/
 * services.  Requests are issued with native `fetch`; no external HTTP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoist mocks ─────────────────────────────────────────────────────────────

const { mockGetTeamFromToken, mockRedis, mockDb } = vi.hoisted(() => ({
  mockGetTeamFromToken: vi.fn(),
  mockRedis: {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    setex: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
  },
  mockDb: {
    // contacts / books
    contactBook: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    contact: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    // topics
    topic: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    contactTopic: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    // segments
    segment: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    segmentContact: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // contact properties
    contactProperty: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // templates
    template: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    templateVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    // broadcasts (campaigns)
    campaign: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    campaignEmail: { deleteMany: vi.fn() },
    // emails
    email: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    emailShare: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    emailAttachment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    // misc
    domain: { findFirst: vi.fn() },
    apiKey: { findUnique: vi.fn() },
    suppressionList: { findFirst: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
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
vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: { queueEmail: vi.fn() },
}));
vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: { emit: vi.fn() },
}));
vi.mock("~/server/service/limit-service", () => ({
  LimitService: {
    checkContactBookLimit: vi.fn().mockResolvedValue({ isLimitReached: false }),
  },
}));
vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: { checkMultipleEmails: vi.fn().mockResolvedValue({}) },
}));
vi.mock("~/server/service/contact-queue-service", () => ({
  ContactQueueService: { addBulkContactJobs: vi.fn() },
}));
vi.mock("~/server/service/double-opt-in-service", () => ({
  sendDoubleOptInConfirmationEmail: vi.fn(),
}));
vi.mock("~/server/service/storage-service", () => ({
  isStorageConfigured: vi.fn().mockReturnValue(false),
  getStoragePublicUrl: vi.fn((key: string) => `https://storage.test/${key}`),
  getDocumentUploadUrl: vi.fn(),
}));
vi.mock("~/server/service/content-screening-service", () => ({
  ContentScreeningService: { assertSendable: vi.fn() },
}));
vi.mock("~/server/service/campaign-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/server/service/campaign-service")>();
  return {
    ...original,
    createCampaignFromApi: vi.fn(),
    sendCampaign: vi.fn(),
    scheduleCampaign: vi.fn(),
    pauseCampaign: vi.fn(),
    deleteCampaign: vi.fn(),
    getCampaignForTeam: vi.fn(),
  };
});
vi.mock("~/server/service/dashboard-service", () => ({
  emailTimeSeries: vi.fn().mockResolvedValue({ result: [], totalCounts: {} }),
  reputationMetricsData: vi.fn().mockResolvedValue({}),
}));
vi.mock("~/server/mailer", () => ({ sendMail: vi.fn() }));
vi.mock("~/server/provider", () => ({
  getEmailProvider: vi.fn(),
  getProviderRegion: vi.fn(),
}));
vi.mock("~/lib/contact-properties", () => ({
  normalizeContactProperties: (p: Record<string, string>) => p,
  mergeContactProperties: (_existing: unknown, incoming: unknown) => incoming,
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

// ── Import after mocks ───────────────────────────────────────────────────────

import { buildResendApp } from "~/server/public-api/resend";
import * as campaignService from "~/server/service/campaign-service";

const BASE = "https://api.mail.scribase.test";
const PREFIX = "/api/resend";

const FULL_TEAM = {
  id: 1,
  apiRateLimit: 10,
  apiKeyId: 11,
  apiKey: { domainId: null, permission: "FULL" },
};

function setup() {
  const app = buildResendApp();
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const rewritten = new URL(`${PREFIX}${url.pathname}${url.search}`, "http://localhost");
    return app.fetch(new Request(rewritten, req));
  }) as typeof fetch;

  return { restore: () => { globalThis.fetch = realFetch; } };
}

function api(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    headers: { Authorization: "Bearer us_test", "Content-Type": "application/json" },
    ...init,
  });
}

function post(path: string, body: unknown) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

function patch(path: string, body: unknown) {
  return api(path, { method: "PATCH", body: JSON.stringify(body) });
}

function del(path: string) {
  return api(path, { method: "DELETE" });
}

// ── Shared setup ─────────────────────────────────────────────────────────────

let server: ReturnType<typeof setup>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTeamFromToken.mockResolvedValue(FULL_TEAM);
  mockRedis.incr.mockResolvedValue(1);
  server = setup();
});

afterEach(() => {
  server.restore();
});

// ── Topics ───────────────────────────────────────────────────────────────────

describe("topics", () => {
  const TOPIC = {
    id: "top_1",
    teamId: 1,
    name: "Newsletter",
    description: null,
    defaultSubscription: "OPT_IN",
    visibility: "PRIVATE",
    createdAt: new Date("2026-10-07T00:00:00Z"),
    updatedAt: new Date("2026-10-07T00:00:00Z"),
  };

  it("POST /topics creates a topic", async () => {
    mockDb.topic.create.mockResolvedValue(TOPIC);
    const res = await post("/topics", { name: "Newsletter" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      object: "topic",
      id: "top_1",
      name: "Newsletter",
      default_subscription: "OPT_IN",
      visibility: "PRIVATE",
    });
  });

  it("GET /topics returns list", async () => {
    mockDb.topic.findMany.mockResolvedValue([TOPIC]);
    const res = await api("/topics");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("top_1");
  });

  it("GET /topics/:id returns topic", async () => {
    mockDb.topic.findFirst.mockResolvedValue(TOPIC);
    const res = await api("/topics/top_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("top_1");
  });

  it("GET /topics/:id returns 404 for unknown", async () => {
    mockDb.topic.findFirst.mockResolvedValue(null);
    const res = await api("/topics/top_missing");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.name).toBe("not_found");
  });

  it("PATCH /topics/:id updates a topic", async () => {
    mockDb.topic.findFirst.mockResolvedValue(TOPIC);
    mockDb.topic.update.mockResolvedValue({ ...TOPIC, name: "Updates" });
    const res = await patch("/topics/top_1", { name: "Updates" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Updates");
  });

  it("DELETE /topics/:id deletes topic", async () => {
    mockDb.topic.findFirst.mockResolvedValue(TOPIC);
    mockDb.topic.delete.mockResolvedValue(TOPIC);
    const res = await del("/topics/top_1");
    expect(res.status).toBe(200);
  });
});

// ── Segments ─────────────────────────────────────────────────────────────────

describe("segments", () => {
  const SEG = {
    id: "seg_1",
    teamId: 1,
    name: "VIP",
    createdAt: new Date("2026-10-07T00:00:00Z"),
    updatedAt: new Date("2026-10-07T00:00:00Z"),
    _count: { contacts: 0 },
  };

  it("POST /segments creates segment", async () => {
    mockDb.segment.create.mockResolvedValue(SEG);
    const res = await post("/segments", { name: "VIP" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("segment");
    expect(body.id).toBe("seg_1");
  });

  it("GET /segments returns list", async () => {
    mockDb.segment.findMany.mockResolvedValue([SEG]);
    const res = await api("/segments");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data[0].name).toBe("VIP");
  });

  it("DELETE /segments/:id deletes segment", async () => {
    mockDb.segment.findFirst.mockResolvedValue(SEG);
    mockDb.segment.delete.mockResolvedValue(SEG);
    const res = await del("/segments/seg_1");
    expect(res.status).toBe(200);
  });

  it("/audiences alias returns same structure", async () => {
    mockDb.segment.findMany.mockResolvedValue([SEG]);
    const res = await api("/audiences");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].object).toBe("audience");
  });
});

// ── Contacts ─────────────────────────────────────────────────────────────────

describe("contacts", () => {
  const DEFAULT_BOOK = { id: "book_default", teamId: 1, isDefault: true };
  const CONTACT = {
    id: "con_1",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Smith",
    subscribed: true,
    contactBookId: "book_default",
    properties: {},
    createdAt: new Date("2026-10-07T00:00:00Z"),
    updatedAt: new Date("2026-10-07T00:00:00Z"),
    unsubscribeReason: null,
  };

  beforeEach(() => {
    mockDb.contactBook.findFirst.mockResolvedValue(DEFAULT_BOOK);
  });

  it("POST /contacts creates contact", async () => {
    mockDb.contactBook.findUnique.mockResolvedValue({
      id: "book_default",
      teamId: 1,
      doubleOptInEnabled: false,
      variables: [],
    });
    mockDb.contact.findUnique.mockResolvedValue(null);
    mockDb.contact.upsert.mockResolvedValue(CONTACT);
    const res = await post("/contacts", {
      email: "alice@example.com",
      first_name: "Alice",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("contact");
    expect(body.email).toBe("alice@example.com");
    expect(body.first_name).toBe("Alice");
    expect(body.unsubscribed).toBe(false);
  });

  it("GET /contacts/:id returns contact by id", async () => {
    mockDb.contact.findFirst.mockResolvedValue(CONTACT);
    const res = await api("/contacts/con_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("con_1");
  });

  it("GET /contacts/:email returns contact by email", async () => {
    // First findFirst (by id) returns null, second (by email) returns contact.
    mockDb.contact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(CONTACT);
    const res = await api("/contacts/alice@example.com");
    expect(res.status).toBe(200);
  });

  it("DELETE /contacts/:id deletes contact", async () => {
    mockDb.contact.findFirst.mockResolvedValue(CONTACT);
    mockDb.contact.delete.mockResolvedValue(CONTACT);
    const res = await del("/contacts/con_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it("creates default book on first use", async () => {
    mockDb.contactBook.findFirst.mockResolvedValue(null);
    mockDb.contactBook.create.mockResolvedValue(DEFAULT_BOOK);
    mockDb.contact.findFirst.mockResolvedValue(null);
    const res = await api("/contacts/missing");
    // missing contact → 404, but the book was created
    expect(mockDb.contactBook.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isDefault: true }) }),
    );
    expect(res.status).toBe(404);
  });
});

// ── Contact properties ────────────────────────────────────────────────────────

describe("contact-properties", () => {
  const PROP = {
    id: "prop_1",
    teamId: 1,
    key: "plan",
    type: "STRING",
    fallbackValue: "free",
    createdAt: new Date("2026-10-07T00:00:00Z"),
    updatedAt: new Date("2026-10-07T00:00:00Z"),
  };

  it("POST /contact-properties creates property", async () => {
    mockDb.contactProperty.create.mockResolvedValue(PROP);
    const res = await post("/contact-properties", { key: "plan", type: "string" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("contact_property");
    expect(body.key).toBe("plan");
    expect(body.type).toBe("string");
  });

  it("GET /contact-properties returns list", async () => {
    mockDb.contactProperty.findMany.mockResolvedValue([PROP]);
    const res = await api("/contact-properties");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].id).toBe("prop_1");
  });

  it("rejects invalid key format", async () => {
    const res = await post("/contact-properties", { key: "123-bad", type: "string" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.name).toBe("validation_error");
  });
});

// ── Templates ────────────────────────────────────────────────────────────────

describe("templates", () => {
  const TMPL = {
    id: "tmpl_1",
    teamId: 1,
    name: "Welcome",
    subject: "Hi {{name}}",
    html: "<p>Hi {{{name|Friend}}}</p>",
    content: null,
    alias: "welcome",
    variables: [{ key: "name", type: "string", fallback_value: "Friend" }],
    publishedAt: null,
    createdAt: new Date("2026-10-07T00:00:00Z"),
    updatedAt: new Date("2026-10-07T00:00:00Z"),
    versions: [],
    _count: { versions: 0 },
  };

  it("POST /templates creates template", async () => {
    mockDb.template.findFirst.mockResolvedValue(null); // alias check
    mockDb.template.create.mockResolvedValue(TMPL);
    const res = await post("/templates", {
      name: "Welcome",
      subject: "Hi {{name}}",
      alias: "welcome",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("template");
    expect(body.id).toBe("tmpl_1");
    expect(body.alias).toBe("welcome");
  });

  it("GET /templates lists templates", async () => {
    mockDb.template.findMany.mockResolvedValue([TMPL]);
    const res = await api("/templates");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].name).toBe("Welcome");
  });

  it("POST /templates/:id/publish creates a version", async () => {
    mockDb.template.findFirst.mockResolvedValue(TMPL);
    mockDb.templateVersion.findFirst.mockResolvedValue(null);
    const VERSION = {
      id: "ver_1",
      templateId: "tmpl_1",
      version: 1,
      subject: "Hi {{name}}",
      html: "<p>Hi</p>",
      content: null,
      variables: [],
      publishedAt: new Date("2026-10-07T00:00:00Z"),
      createdAt: new Date("2026-10-07T00:00:00Z"),
    };
    mockDb.templateVersion.create.mockResolvedValue(VERSION);
    mockDb.template.update.mockResolvedValue({ ...TMPL, publishedAt: VERSION.publishedAt });
    const res = await post("/templates/tmpl_1/publish", {});
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("template_version");
    expect(body.version).toBe(1);
  });

  it("POST /templates/:id/duplicate creates a copy", async () => {
    mockDb.template.findFirst.mockResolvedValue(TMPL);
    mockDb.template.create.mockResolvedValue({ ...TMPL, id: "tmpl_2", name: "Welcome (copy)", alias: null });
    const res = await post("/templates/tmpl_1/duplicate", {});
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Welcome (copy)");
    expect(body.alias).toBeNull();
  });
});

// ── Template variable resolution ──────────────────────────────────────────────

describe("TemplateService.applyVariables", async () => {
  const { TemplateService } = await import("~/server/service/template-service");

  it("replaces {{{VAR}}} triple-moustache", () => {
    const result = TemplateService.applyVariables(
      "Hello {{{name}}}",
      { name: "Alice" },
      [],
    );
    expect(result).toBe("Hello Alice");
  });

  it("replaces {{VAR}} double-moustache", () => {
    const result = TemplateService.applyVariables(
      "Hello {{name}}",
      { name: "Alice" },
      [],
    );
    expect(result).toBe("Hello Alice");
  });

  it("uses fallback_value when var is absent", () => {
    const result = TemplateService.applyVariables(
      "Hello {{{name}}}",
      {},
      [{ key: "name", type: "string", fallback_value: "Friend" }],
    );
    expect(result).toBe("Hello Friend");
  });

  it("leaves placeholder intact when no value and no fallback", () => {
    const result = TemplateService.applyVariables(
      "Hello {{{name}}}",
      {},
      [],
    );
    expect(result).toBe("Hello {{{name}}}");
  });
});

// ── Broadcasts ───────────────────────────────────────────────────────────────

describe("broadcasts", () => {
  const CAMP = {
    id: "camp_1",
    teamId: 1,
    name: "Product Launch",
    from: "hello@acme.dev",
    subject: "Big news",
    previewText: null,
    contactBookId: "book_1",
    topicId: null,
    status: "DRAFT",
    scheduledAt: null,
    total: 0,
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    unsubscribed: 0,
    bounced: 0,
    complained: 0,
    createdAt: new Date("2026-10-07T00:00:00Z"),
    updatedAt: new Date("2026-10-07T00:00:00Z"),
  };

  it("POST /broadcasts creates broadcast", async () => {
    vi.mocked(campaignService.createCampaignFromApi).mockResolvedValue(CAMP as never);
    mockDb.campaign.update.mockResolvedValue(CAMP);
    mockDb.campaign.findUniqueOrThrow.mockResolvedValue(CAMP);
    const res = await post("/broadcasts", {
      name: "Product Launch",
      audience_id: "book_1",
      from: "hello@acme.dev",
      subject: "Big news",
      html: "<p>News {{unsend_unsubscribe_url}}</p>",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("broadcast");
    expect(body.id).toBe("camp_1");
    expect(body.status).toBe("draft");
  });

  it("GET /broadcasts/:id returns broadcast", async () => {
    mockDb.campaign.findFirst.mockResolvedValue(CAMP);
    const res = await api("/broadcasts/camp_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audience_id).toBe("book_1");
  });

  it("POST /broadcasts/:id/send calls sendCampaign", async () => {
    mockDb.campaign.findFirst.mockResolvedValue(CAMP);
    vi.mocked(campaignService.sendCampaign).mockResolvedValue();
    const res = await post("/broadcasts/camp_1/send", {});
    expect(res.status).toBe(200);
    expect(campaignService.sendCampaign).toHaveBeenCalledWith("camp_1");
  });

  it("POST /broadcasts/:id/cancel calls pauseCampaign", async () => {
    mockDb.campaign.findFirst.mockResolvedValue(CAMP);
    vi.mocked(campaignService.pauseCampaign).mockResolvedValue({ ok: true });
    const res = await post("/broadcasts/camp_1/cancel", {});
    expect(res.status).toBe(200);
    expect(campaignService.pauseCampaign).toHaveBeenCalledWith({
      campaignId: "camp_1",
      teamId: 1,
    });
  });

  it("POST /broadcasts/:id/duplicate creates copy", async () => {
    mockDb.campaign.findFirst.mockResolvedValue(CAMP);
    mockDb.campaign.create.mockResolvedValue({ ...CAMP, id: "camp_2", name: "Product Launch (copy)" });
    const res = await post("/broadcasts/camp_1/duplicate", {});
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Product Launch (copy)");
  });

  it("returns 404 for missing broadcast", async () => {
    mockDb.campaign.findFirst.mockResolvedValue(null);
    const res = await api("/broadcasts/missing");
    expect(res.status).toBe(404);
  });
});

// ── Attachments ───────────────────────────────────────────────────────────────

describe("attachments", () => {
  it("GET /emails/:id/attachments returns attachment list", async () => {
    mockDb.email.findFirst.mockResolvedValue({ id: "em_1" });
    mockDb.emailAttachment.findMany.mockResolvedValue([
      {
        id: "att_1",
        filename: "invoice.pdf",
        contentType: "application/pdf",
        contentId: null,
        inline: false,
        sizeBytes: 12345,
        storageKey: null,
        createdAt: new Date("2026-10-07T00:00:00Z"),
      },
    ]);
    const res = await api("/emails/em_1/attachments");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      object: "attachment",
      id: "att_1",
      filename: "invoice.pdf",
      url: null,
    });
  });

  it("returns 404 for unknown email", async () => {
    mockDb.email.findFirst.mockResolvedValue(null);
    const res = await api("/emails/em_missing/attachments");
    expect(res.status).toBe(404);
  });
});

// ── Share ──────────────────────────────────────────────────────────────────────

describe("share", () => {
  it("POST /emails/:id/share returns a URL", async () => {
    mockDb.email.findFirst.mockResolvedValue({ id: "em_1" });
    mockDb.emailShare.create.mockImplementation(async ({ data }: { data: { token: string; expiresAt: Date } }) => ({
      id: "share_1",
      token: data.token,
      expiresAt: data.expiresAt,
    }));
    const res = await post("/emails/em_1/share", {});
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("email_share");
    expect(body.url).toMatch(/\/share\/[A-Za-z0-9_-]{30,}$/);
    expect(body.email_id).toBe("em_1");
    expect(body.expires_at).toBeTruthy();
  });
});

// ── Metrics ──────────────────────────────────────────────────────────────────

describe("metrics", () => {
  it("GET /emails/metrics returns metrics", async () => {
    const { emailTimeSeries } = await import("~/server/service/dashboard-service");
    const { reputationMetricsData } = await import("~/server/service/dashboard-service");
    vi.mocked(emailTimeSeries).mockResolvedValue({
      result: [],
      totalCounts: { sent: 100, delivered: 95, opened: 30, clicked: 10, bounced: 5, complained: 0 },
    });
    vi.mocked(reputationMetricsData).mockResolvedValue({ deliveryRate: 0.95, openRate: 0.315 } as never);

    const res = await api("/emails/metrics?days=7");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("email_metrics");
    expect(body.period_days).toBe(7);
    expect(body.totals.sent).toBe(100);
  });

  it("returns 404 for unknown domain_id", async () => {
    mockDb.domain.findFirst.mockResolvedValue(null);
    const res = await api("/emails/metrics?domain_id=999");
    expect(res.status).toBe(404);
  });
});

// ── Personalization helpers ───────────────────────────────────────────────────

describe("applyResendPersonalization", async () => {
  const { applyResendPersonalization } = await import("~/server/service/personalization");

  it("substitutes contact.first_name", () => {
    const result = applyResendPersonalization(
      "Hi {{{contact.first_name|Friend}}}",
      { firstName: "Alice" },
      "https://example.com/unsub",
    );
    expect(result).toBe("Hi Alice");
  });

  it("uses fallback when field is absent", () => {
    const result = applyResendPersonalization(
      "Hi {{{contact.first_name|Friend}}}",
      {},
      "https://example.com/unsub",
    );
    expect(result).toBe("Hi Friend");
  });

  it("substitutes RESEND_UNSUBSCRIBE_URL", () => {
    const result = applyResendPersonalization(
      "<a href=\"{{{RESEND_UNSUBSCRIBE_URL}}}\">Unsub</a>",
      {},
      "https://example.com/unsub?id=1",
    );
    expect(result).toBe('<a href="https://example.com/unsub?id=1">Unsub</a>');
  });
});
