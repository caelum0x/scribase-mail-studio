import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockProvider, mockProcessEmailEvent, mockCheckEmailLimit } =
  vi.hoisted(() => ({
    mockDb: {
      email: { findUnique: vi.fn(), update: vi.fn() },
      domain: { findUnique: vi.fn() },
      contact: { findUnique: vi.fn() },
      emailEvent: { create: vi.fn() },
    },
    mockProvider: {
      ensureApprovedSender: vi.fn(),
      sendRawEmail: vi.fn(),
    },
    mockProcessEmailEvent: vi.fn(),
    mockCheckEmailLimit: vi.fn(),
  }));

vi.mock("~/env", () => ({
  env: {
    NEXTAUTH_URL: "https://mail.scribase.com",
    NEXTAUTH_SECRET: "test-secret",
  },
}));
vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/provider", () => ({
  getEmailProvider: () => mockProvider,
  getProviderRegion: () => "eu-frankfurt-1",
}));
vi.mock("~/server/service/email-event-service", () => ({
  processEmailEvent: mockProcessEmailEvent,
}));
vi.mock("~/server/service/limit-service", () => ({
  LimitService: { checkEmailLimit: mockCheckEmailLimit },
}));
vi.mock("~/server/redis", () => ({
  BULL_PREFIX: "test",
  getRedis: vi.fn(() => ({})),
}));
vi.mock("bullmq", () => ({
  Queue: class {},
  Worker: class {},
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getChildLogger: vi.fn(),
  withLogger: vi.fn(),
}));

import { ProviderSendError } from "~/server/provider/types";
import { buildMessageId, executeEmail } from "./email-queue-service";

const email = {
  id: "em_1",
  from: "Acme <hello@acme.test>",
  to: ["user@example.com"],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Hi",
  text: "Hi",
  html: '<html><body><a href="https://example.com">x</a></body></html>',
  teamId: 7,
  domainId: 3,
  campaignId: null,
  contactId: null,
  inReplyToId: null,
  attachments: null,
  headers: null,
};

function job(attemptsMade = 0, attempts = 4) {
  return {
    data: { emailId: "em_1", timestamp: Date.now(), teamId: 7 },
    attemptsMade,
    opts: { attempts },
  } as never;
}

describe("executeEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.email.findUnique.mockResolvedValue(email);
    mockDb.domain.findUnique.mockResolvedValue({
      id: 3,
      name: "acme.test",
      openTracking: true,
      clickTracking: true,
    });
    mockCheckEmailLimit.mockResolvedValue({ isLimitReached: false });
    mockProvider.ensureApprovedSender.mockResolvedValue({ created: false });
  });

  it("sends through the provider and records the SENT event", async () => {
    mockProvider.sendRawEmail.mockResolvedValue({
      messageId: "em_1@acme.test",
      accepted: ["user@example.com"],
      rejected: [],
      response: "250 Ok",
    });

    await executeEmail(job());

    expect(mockProvider.ensureApprovedSender).toHaveBeenCalledWith(
      "Acme <hello@acme.test>",
    );
    const input = mockProvider.sendRawEmail.mock.calls[0]![0];
    expect(input.messageId).toBe("em_1@acme.test");
    expect(input.headers["X-Scribase-Email-ID"]).toBe("em_1");
    expect(input.html).toContain("/api/t/c/em_1?u=https%3A%2F%2Fexample.com");
    expect(input.html).toContain("/api/t/o/em_1?s=");
    expect(mockDb.email.update).toHaveBeenCalledWith({
      where: { id: "em_1" },
      data: expect.objectContaining({ providerMessageId: "em_1@acme.test" }),
    });
    expect(mockProcessEmailEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "Send",
        mail: expect.objectContaining({
          emailId: "em_1",
          messageId: "em_1@acme.test",
        }),
      }),
    );
    expect(mockDb.emailEvent.create).not.toHaveBeenCalled();
  });

  it("marks the email FAILED on a permanent provider error", async () => {
    mockProvider.sendRawEmail.mockRejectedValue(
      new ProviderSendError("SMTP send failed (550): rejected", {
        retryable: false,
        responseCode: 550,
      }),
    );

    await executeEmail(job());

    expect(mockDb.emailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        emailId: "em_1",
        status: "FAILED",
        data: { error: "SMTP send failed (550): rejected" },
      }),
    });
    expect(mockDb.email.update).toHaveBeenCalledWith({
      where: { id: "em_1" },
      data: { latestStatus: "FAILED" },
    });
    expect(mockProcessEmailEvent).not.toHaveBeenCalled();
  });

  it("rethrows transient errors so the queue retries", async () => {
    mockProvider.sendRawEmail.mockRejectedValue(
      new ProviderSendError("try later", {
        retryable: true,
        responseCode: 451,
      }),
    );

    await expect(executeEmail(job(0, 4))).rejects.toThrow("try later");
    expect(mockDb.emailEvent.create).not.toHaveBeenCalled();
  });

  it("marks FAILED when transient errors exhaust all attempts", async () => {
    mockProvider.sendRawEmail.mockRejectedValue(
      new ProviderSendError("try later", {
        retryable: true,
        responseCode: 451,
      }),
    );

    await executeEmail(job(3, 4));

    expect(mockDb.email.update).toHaveBeenCalledWith({
      where: { id: "em_1" },
      data: { latestStatus: "FAILED" },
    });
  });

  it("fails when the approved sender cannot be created", async () => {
    mockProvider.ensureApprovedSender.mockRejectedValue(new Error("403"));

    await executeEmail(job());

    expect(mockProvider.sendRawEmail).not.toHaveBeenCalled();
    expect(mockDb.email.update).toHaveBeenCalledWith({
      where: { id: "em_1" },
      data: { latestStatus: "FAILED" },
    });
  });

  it("does not mark FAILED when only the bookkeeping after send fails", async () => {
    mockProvider.sendRawEmail.mockResolvedValue({
      messageId: "em_1@acme.test",
      accepted: ["user@example.com"],
      rejected: [],
    });
    mockProcessEmailEvent.mockRejectedValue(new Error("db down"));

    await executeEmail(job());

    expect(mockDb.emailEvent.create).not.toHaveBeenCalled();
  });
});

describe("buildMessageId", () => {
  it("uses the sender domain", () => {
    expect(buildMessageId("em_1", "Acme <Hello@Acme.test>")).toBe(
      "em_1@acme.test",
    );
    expect(buildMessageId("em_2", "no-at-sign")).toBe("em_2@scribase.mail");
  });
});
