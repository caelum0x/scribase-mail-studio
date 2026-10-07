/**
 * Unit tests for the received email service.
 * Prisma and WebhookService are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockWebhookEmit } = vi.hoisted(() => ({
  mockDb: {
    domain: { findUnique: vi.fn() },
    receivedEmail: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
  mockWebhookEmit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: { emit: mockWebhookEmit },
}));
vi.mock("~/server/service/inbound-storage-service", () => ({
  getStorageSignedDownloadUrl: vi.fn().mockResolvedValue("https://example.com/signed"),
}));

import {
  persistReceivedEmail,
  getReceivedEmails,
  getReceivedEmailById,
} from "./received-email-service";

const DOMAIN = { id: 7, teamId: 1, receivingEnabled: true };
const CREATED_RECEIVED = {
  id: "rec_xyz",
  from: "sender@example.com",
  to: ["inbox@acme.dev"],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Test inbound",
  text: "Hello",
  html: null,
  headers: null,
  rawStorageKey: null,
  sizeBytes: 512,
  spfResult: "pass",
  dkimResult: "pass",
  dmarcResult: "pass",
  spamScore: null,
  createdAt: new Date("2026-10-07T10:00:00Z"),
  domainId: 7,
};

describe("persistReceivedEmail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a ReceivedEmail row and emits webhook", async () => {
    mockDb.domain.findUnique.mockResolvedValue(DOMAIN);
    mockDb.receivedEmail.create.mockResolvedValue(CREATED_RECEIVED);

    const id = await persistReceivedEmail({
      recipientDomain: "acme.dev",
      from: "sender@example.com",
      to: ["inbox@acme.dev"],
      subject: "Test inbound",
      text: "Hello",
      sizeBytes: 512,
      spfResult: "pass",
      dkimResult: "pass",
      dmarcResult: "pass",
    });

    expect(id).toBe("rec_xyz");
    expect(mockDb.receivedEmail.create).toHaveBeenCalledOnce();
    // Webhook is fire-and-forget; flush microtasks so the .catch() runs.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(mockWebhookEmit).toHaveBeenCalledWith(
      1,
      "email.received",
      expect.objectContaining({ id: "rec_xyz" }),
      expect.any(Object),
    );
  });

  it("throws when domain does not exist", async () => {
    mockDb.domain.findUnique.mockResolvedValue(null);

    await expect(
      persistReceivedEmail({
        recipientDomain: "unknown.dev",
        from: "x@example.com",
        to: ["y@unknown.dev"],
        subject: "Hi",
        sizeBytes: 100,
      }),
    ).rejects.toThrow(/Domain not found/);
  });

  it("throws when receiving is disabled on the domain", async () => {
    mockDb.domain.findUnique.mockResolvedValue({ ...DOMAIN, receivingEnabled: false });

    await expect(
      persistReceivedEmail({
        recipientDomain: "acme.dev",
        from: "x@example.com",
        to: ["y@acme.dev"],
        subject: "Hi",
        sizeBytes: 100,
      }),
    ).rejects.toThrow(/does not have receiving enabled/);
  });
});

describe("getReceivedEmails", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns paginated received emails", async () => {
    mockDb.receivedEmail.findMany.mockResolvedValue([
      { ...CREATED_RECEIVED, attachments: [] },
    ]);

    const result = await getReceivedEmails(1, { limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.has_more).toBe(false);
    expect(result.data[0]!.id).toBe("rec_xyz");
  });

  it("signals has_more when result exceeds limit", async () => {
    // Return limit + 1 items to simulate more pages
    const items = Array.from({ length: 21 }, (_, i) => ({
      ...CREATED_RECEIVED,
      id: `rec_${i}`,
      attachments: [],
    }));
    mockDb.receivedEmail.findMany.mockResolvedValue(items);

    const result = await getReceivedEmails(1, { limit: 20 });

    expect(result.has_more).toBe(true);
    expect(result.data).toHaveLength(20);
  });
});

describe("getReceivedEmailById", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the email when found", async () => {
    mockDb.receivedEmail.findFirst.mockResolvedValue({
      ...CREATED_RECEIVED,
      attachments: [],
    });

    const row = await getReceivedEmailById(1, "rec_xyz");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("rec_xyz");
  });

  it("returns null when not found", async () => {
    mockDb.receivedEmail.findFirst.mockResolvedValue(null);
    const row = await getReceivedEmailById(1, "nonexistent");
    expect(row).toBeNull();
  });
});
