import { EmailStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailEvent } from "~/types/mail-events";

const { mockDb, mockUpdateCampaignAnalytics, mockWebhookEmit } = vi.hoisted(
  () => ({
    mockDb: {
      $executeRaw: vi.fn(),
      email: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      emailEvent: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
      },
      dailyEmailUsage: {
        upsert: vi.fn(),
      },
      cumulatedMetrics: {
        upsert: vi.fn(),
      },
    },
    mockUpdateCampaignAnalytics: vi.fn(),
    mockWebhookEmit: vi.fn(),
  }),
);

vi.mock("~/server/db", () => ({
  db: mockDb,
}));

vi.mock("~/env", () => ({
  env: {
    NEXTAUTH_URL: "https://usesend.example",
  },
}));

vi.mock("~/server/service/campaign-service", () => ({
  unsubscribeContact: vi.fn(),
  updateCampaignAnalytics: mockUpdateCampaignAnalytics,
}));

vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: {
    emit: mockWebhookEmit,
  },
}));

const { mockAddSuppression } = vi.hoisted(() => ({
  mockAddSuppression: vi.fn(),
}));

vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: {
    addSuppression: mockAddSuppression,
  },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn();
  },
  Worker: class {},
}));

vi.mock("~/server/redis", () => ({
  BULL_PREFIX: "test",
  getRedis: vi.fn(() => ({})),
}));

vi.mock("~/server/logger/log", () => ({
  getChildLogger: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    setBindings: vi.fn(),
    warn: vi.fn(),
  },
  withLogger: vi.fn(),
}));

import { processEmailEvent } from "~/server/service/email-event-service";

const email = {
  id: "email_1",
  providerMessageId: "email_1@mail.example.com",
  from: "sender@example.com",
  to: ["recipient@example.com"],
  replyTo: [],
  cc: [],
  bcc: [],
  subject: "Hello",
  text: null,
  html: null,
  latestStatus: EmailStatus.DELIVERED,
  teamId: 7,
  domainId: 11,
  apiId: null,
  createdAt: new Date("2026-07-13T00:00:00.000Z"),
  updatedAt: new Date("2026-07-13T00:00:00.000Z"),
  scheduledAt: null,
  attachments: null,
  campaignId: null,
  contactId: null,
  inReplyToId: null,
  headers: null,
};

function buildEvent(eventType: "Open" | "Click"): MailEvent {
  const event = {
    eventType,
    mail: {
      timestamp: "2026-07-13T01:00:00.000Z",
      emailId: "email_1",
      source: "sender@example.com",
      messageId: "email_1@mail.example.com",
      destination: ["recipient@example.com"],
    },
  } as MailEvent;

  if (eventType === "Open") {
    event.open = {
      ipAddress: "192.0.2.1",
      timestamp: "2026-07-13T01:00:00.000Z",
      userAgent: "test-agent",
    };
  } else {
    event.click = {
      ipAddress: "192.0.2.1",
      timestamp: "2026-07-13T01:00:00.000Z",
      userAgent: "test-agent",
      link: "https://example.com",
      linkTags: {},
    };
  }

  return event;
}

describe("processEmailEvent dashboard engagement usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.email.findUnique.mockResolvedValue(email);
    mockDb.emailEvent.create.mockResolvedValue({});
    mockDb.dailyEmailUsage.upsert.mockResolvedValue({});
    mockWebhookEmit.mockResolvedValue(undefined);
  });

  it.each([
    ["Open", EmailStatus.OPENED],
    ["Click", EmailStatus.CLICKED],
  ] as const)(
    "counts only the first %s event for an email",
    async (eventType, status) => {
      mockDb.emailEvent.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "existing_event", status });

      const event = buildEvent(eventType);
      await processEmailEvent(event);
      await processEmailEvent(event);

      expect(mockDb.emailEvent.findFirst).toHaveBeenNthCalledWith(1, {
        where: {
          emailId: email.id,
          status,
        },
      });
      expect(mockDb.dailyEmailUsage.upsert).toHaveBeenCalledTimes(1);
      expect(mockDb.dailyEmailUsage.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            [status.toLowerCase()]: {
              increment: 1,
            },
          },
        }),
      );
      expect(mockDb.emailEvent.create).toHaveBeenCalledTimes(2);
    },
  );
});

describe("processEmailEvent lookup and send events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.emailEvent.create.mockResolvedValue({});
    mockDb.emailEvent.findFirst.mockResolvedValue(null);
    mockDb.dailyEmailUsage.upsert.mockResolvedValue({});
    mockWebhookEmit.mockResolvedValue(undefined);
  });

  it("looks up the email by Scribase email id first", async () => {
    mockDb.email.findUnique.mockResolvedValue(email);

    await processEmailEvent(buildEvent("Open"));

    expect(mockDb.email.findUnique).toHaveBeenCalledTimes(1);
    expect(mockDb.email.findUnique).toHaveBeenCalledWith({
      where: { id: "email_1" },
    });
  });

  it("falls back to the provider message id", async () => {
    mockDb.email.findUnique.mockResolvedValue(email);
    const event = buildEvent("Open");
    delete event.mail.emailId;

    await processEmailEvent(event);

    expect(mockDb.email.findUnique).toHaveBeenCalledWith({
      where: { providerMessageId: "email_1@mail.example.com" },
    });
  });

  it("returns false when the email cannot be found", async () => {
    mockDb.email.findUnique.mockResolvedValue(null);

    await expect(processEmailEvent(buildEvent("Click"))).resolves.toBe(false);
    expect(mockDb.emailEvent.create).not.toHaveBeenCalled();
  });

  it("records a SENT event and emits email.sent", async () => {
    mockDb.email.findUnique.mockResolvedValue({
      ...email,
      latestStatus: EmailStatus.QUEUED,
    });

    const event: MailEvent = {
      eventType: "Send",
      mail: {
        timestamp: "2026-07-13T01:00:00.000Z",
        emailId: "email_1",
        messageId: "email_1@mail.example.com",
      },
      send: {
        timestamp: "2026-07-13T01:00:00.000Z",
        smtpResponse: "250 Ok",
        recipients: ["recipient@example.com"],
      },
    };

    await expect(processEmailEvent(event)).resolves.toBe(true);

    expect(mockDb.emailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        emailId: "email_1",
        status: EmailStatus.SENT,
      }),
    });
    expect(mockWebhookEmit).toHaveBeenCalledWith(
      7,
      "email.sent",
      expect.objectContaining({ id: "email_1", status: EmailStatus.SENT }),
      { domainId: 11 },
    );
  });
});

describe("processEmailEvent delivery outcome dedupe", () => {
  function bounceEvent(bounceType: "Permanent" | "Transient"): MailEvent {
    return {
      eventType: "Bounce",
      mail: {
        timestamp: "2026-07-13T01:00:00.000Z",
        emailId: "email_1",
        messageId: "email_1@mail.example.com",
      },
      bounce: {
        bounceType,
        bounceSubType: "NoEmail",
        bouncedRecipients: [
          {
            emailAddress: "recipient@example.com",
            action: "failed",
            status: "5.1.1",
          },
        ],
        timestamp: "2026-07-13T01:00:00.000Z",
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.email.findUnique.mockResolvedValue(email);
    mockDb.emailEvent.create.mockResolvedValue({});
    mockDb.emailEvent.findFirst.mockResolvedValue(null);
    mockDb.dailyEmailUsage.upsert.mockResolvedValue({});
    mockDb.cumulatedMetrics.upsert.mockResolvedValue({});
    mockWebhookEmit.mockResolvedValue(undefined);
  });

  it("records the first hard bounce with usage, suppression and webhook", async () => {
    mockDb.emailEvent.findMany.mockResolvedValue([]);

    await expect(processEmailEvent(bounceEvent("Permanent"))).resolves.toBe(
      true,
    );

    expect(mockDb.emailEvent.findMany).toHaveBeenCalledWith({
      where: { emailId: "email_1", status: EmailStatus.BOUNCED },
      select: { data: true },
    });
    expect(mockAddSuppression).toHaveBeenCalledTimes(1);
    expect(mockDb.dailyEmailUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { bounced: { increment: 1 }, hardBounced: { increment: 1 } },
      }),
    );
    expect(mockDb.emailEvent.create).toHaveBeenCalledTimes(1);
    expect(mockWebhookEmit).toHaveBeenCalledTimes(1);
  });

  it("drops the same bounce reported by the second source", async () => {
    mockDb.emailEvent.findMany.mockResolvedValue([
      { data: bounceEvent("Permanent").bounce },
    ]);

    await expect(processEmailEvent(bounceEvent("Permanent"))).resolves.toBe(
      true,
    );

    expect(mockDb.$executeRaw).not.toHaveBeenCalled();
    expect(mockDb.dailyEmailUsage.upsert).not.toHaveBeenCalled();
    expect(mockDb.emailEvent.create).not.toHaveBeenCalled();
    expect(mockWebhookEmit).not.toHaveBeenCalled();
  });

  it("counts only hardBounced when a soft bounce turns permanent", async () => {
    mockDb.emailEvent.findMany.mockResolvedValue([
      { data: bounceEvent("Transient").bounce },
    ]);

    await processEmailEvent(bounceEvent("Permanent"));

    expect(mockDb.dailyEmailUsage.upsert).toHaveBeenCalledTimes(1);
    expect(mockDb.dailyEmailUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { hardBounced: { increment: 1 } } }),
    );
    expect(mockDb.cumulatedMetrics.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { hardBounced: { increment: BigInt(1) } },
      }),
    );
    expect(mockAddSuppression).toHaveBeenCalledTimes(1);
    expect(mockDb.emailEvent.create).toHaveBeenCalledTimes(1);
  });

  it("counts a delivery once per email", async () => {
    mockDb.emailEvent.findMany.mockResolvedValue([]);
    const event: MailEvent = {
      eventType: "Delivery",
      mail: {
        timestamp: "2026-07-13T01:00:00.000Z",
        emailId: "email_1",
      },
      delivery: {
        timestamp: "2026-07-13T01:00:00.000Z",
        processingTimeMillis: 10,
        recipients: ["recipient@example.com"],
        smtpResponse: "250 ok",
        reportingMTA: "mx.example.com",
      },
    };

    await processEmailEvent(event);
    expect(mockDb.dailyEmailUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { delivered: { increment: 1 } } }),
    );
    expect(mockWebhookEmit).toHaveBeenCalledWith(
      7,
      "email.delivered",
      expect.anything(),
      { domainId: 11 },
    );
  });
});
