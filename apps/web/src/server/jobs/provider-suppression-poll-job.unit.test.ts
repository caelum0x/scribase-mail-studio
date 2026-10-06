import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EmailProvider,
  ProviderSuppressionDetail,
} from "~/server/provider/types";

const { mockDb, processed, appSettings } = vi.hoisted(() => {
  const processed = new Map<string, unknown>();
  const appSettings = new Map<string, string>();
  return {
    processed,
    appSettings,
    mockDb: {
      processedProviderSuppression: {
        findMany: vi.fn(
          async ({ where }: { where: { id: { in: string[] } } }) =>
            where.id.in.filter((id) => processed.has(id)).map((id) => ({ id })),
        ),
        create: vi.fn(async ({ data }: { data: { id: string } }) => {
          processed.set(data.id, data);
          return data;
        }),
      },
      appSetting: {
        findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
          appSettings.has(where.key)
            ? { key: where.key, value: appSettings.get(where.key) }
            : null,
        ),
        upsert: vi.fn(
          async ({
            where,
            create,
            update,
          }: {
            where: { key: string };
            create: { value: string };
            update: { value: string };
          }) => {
            const value = appSettings.has(where.key)
              ? update.value
              : create.value;
            appSettings.set(where.key, value);
            return { key: where.key, value };
          },
        ),
      },
      email: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
    },
  };
});

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/server/redis", () => ({
  BULL_PREFIX: "test",
  getRedis: vi.fn(() => ({})),
}));
vi.mock("bullmq", () => ({
  Queue: class {
    upsertJobScheduler = vi.fn();
  },
  Worker: class {
    on = vi.fn();
  },
}));
vi.mock("~/server/service/email-event-service", () => ({
  processEmailEvent: vi.fn(),
}));
vi.mock("~/server/provider", () => ({
  getEmailProvider: vi.fn(),
}));

import {
  SUPPRESSION_CURSOR_KEY,
  SUPPRESSION_POLL_OVERLAP_MS,
  pollProviderSuppressions,
} from "./provider-suppression-poll-job";

const sentEmail = {
  id: "em_1",
  teamId: 7,
  providerMessageId: "em_1@acme.test",
};

function detail(
  overrides: Partial<ProviderSuppressionDetail> = {},
): ProviderSuppressionDetail {
  return {
    id: "s1",
    email: "bounced@example.com",
    reason: "HARD_BOUNCE",
    createdAt: new Date("2026-10-07T10:00:00Z"),
    messageId: "em_1@acme.test",
    errorDetail: "550 5.1.1 user unknown",
    errorSource: "mx.example.com",
    ...overrides,
  };
}

function createProvider(details: ProviderSuppressionDetail[]) {
  return {
    listSuppressions: vi.fn(async () =>
      details.map(({ id, email, reason, createdAt }) => ({
        id,
        email,
        reason,
        createdAt,
      })),
    ),
    getSuppression: vi.fn(async (id: string) => {
      const found = details.find((d) => d.id === id);
      if (!found) throw new Error("not found");
      return found;
    }),
  } as unknown as EmailProvider & {
    listSuppressions: ReturnType<typeof vi.fn>;
    getSuppression: ReturnType<typeof vi.fn>;
  };
}

const now = new Date("2026-10-07T12:00:00Z");

describe("pollProviderSuppressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processed.clear();
    appSettings.clear();
    mockDb.email.findUnique.mockResolvedValue(sentEmail);
    mockDb.email.findFirst.mockResolvedValue(null);
  });

  it("maps a hard bounce to a permanent Bounce event for the sent email", async () => {
    const provider = createProvider([detail()]);
    const handleEvent = vi.fn().mockResolvedValue(true);

    const result = await pollProviderSuppressions({
      provider,
      handleEvent,
      now,
    });

    expect(mockDb.email.findUnique).toHaveBeenCalledWith({
      where: { providerMessageId: "em_1@acme.test" },
    });
    expect(handleEvent).toHaveBeenCalledTimes(1);
    const event = handleEvent.mock.calls[0]![0];
    expect(event).toMatchObject({
      eventType: "Bounce",
      mail: { emailId: "em_1", messageId: "em_1@acme.test" },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "NoEmail",
        bouncedRecipients: [
          {
            emailAddress: "bounced@example.com",
            diagnosticCode: "550 5.1.1 user unknown",
          },
        ],
        reportingMTA: "mx.example.com",
      },
    });
    expect(result).toEqual({ seen: 1, emitted: 1, skipped: 0, failed: 0 });
    expect(processed.has("s1")).toBe(true);
  });

  it("does not emit duplicates across polls", async () => {
    const provider = createProvider([detail()]);
    const handleEvent = vi.fn().mockResolvedValue(true);

    await pollProviderSuppressions({ provider, handleEvent, now });
    const second = await pollProviderSuppressions({
      provider,
      handleEvent,
      now,
    });

    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(provider.getSuppression).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ seen: 1, emitted: 0, skipped: 0, failed: 0 });
  });

  it("maps complaints and soft bounces", async () => {
    const provider = createProvider([
      detail({ id: "c1", reason: "COMPLAINT" }),
      detail({
        id: "b2",
        reason: "SOFT_BOUNCE",
        errorDetail: "452 mailbox full",
      }),
    ]);
    const handleEvent = vi.fn().mockResolvedValue(true);

    await pollProviderSuppressions({ provider, handleEvent, now });

    const [complaint, softBounce] = handleEvent.mock.calls.map((c) => c[0]);
    expect(complaint).toMatchObject({
      eventType: "Complaint",
      complaint: {
        complainedRecipients: [{ emailAddress: "bounced@example.com" }],
        complaintFeedbackType: "abuse",
      },
    });
    expect(softBounce).toMatchObject({
      eventType: "Bounce",
      bounce: { bounceType: "Transient", bounceSubType: "MailboxFull" },
    });
  });

  it("records but ignores manual, unsubscribe and unknown suppressions", async () => {
    const provider = createProvider([
      detail({ id: "m1", reason: "MANUAL" }),
      detail({ id: "u1", reason: "UNSUBSCRIBE" }),
      detail({ id: "x1", reason: "UNKNOWN" }),
    ]);
    const handleEvent = vi.fn();

    const result = await pollProviderSuppressions({
      provider,
      handleEvent,
      now,
    });

    expect(handleEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ seen: 3, emitted: 0, skipped: 3, failed: 0 });
    expect([...processed.keys()].sort()).toEqual(["m1", "u1", "x1"]);
  });

  it("falls back to the latest email sent to the address", async () => {
    mockDb.email.findUnique.mockResolvedValue(null);
    mockDb.email.findFirst.mockResolvedValue({
      id: "em_9",
      teamId: 7,
      providerMessageId: "em_9@acme.test",
    });
    const provider = createProvider([detail({ messageId: undefined })]);
    const handleEvent = vi.fn().mockResolvedValue(true);

    await pollProviderSuppressions({ provider, handleEvent, now });

    expect(mockDb.email.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          to: { has: "bounced@example.com" },
        }),
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(handleEvent.mock.calls[0]![0].mail.emailId).toBe("em_9");
  });

  it("skips entries with no matching email", async () => {
    mockDb.email.findUnique.mockResolvedValue(null);
    mockDb.email.findFirst.mockResolvedValue(null);
    const provider = createProvider([detail()]);
    const handleEvent = vi.fn();

    const result = await pollProviderSuppressions({
      provider,
      handleEvent,
      now,
    });

    expect(handleEvent).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(processed.has("s1")).toBe(true);
  });

  it("retries entries whose event handling failed", async () => {
    const provider = createProvider([detail()]);
    const handleEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(true);

    const first = await pollProviderSuppressions({
      provider,
      handleEvent,
      now,
    });
    expect(first.failed).toBe(1);
    expect(processed.has("s1")).toBe(false);

    const second = await pollProviderSuppressions({
      provider,
      handleEvent,
      now,
    });
    expect(second.emitted).toBe(1);
    expect(processed.has("s1")).toBe(true);
  });

  it("polls from the stored cursor minus the overlap and advances it", async () => {
    appSettings.set(SUPPRESSION_CURSOR_KEY, "2026-10-07T09:00:00.000Z");
    const provider = createProvider([
      detail({ id: "a", createdAt: new Date("2026-10-07T10:00:00Z") }),
      detail({ id: "b", createdAt: new Date("2026-10-07T11:00:00Z") }),
    ]);

    await pollProviderSuppressions({
      provider,
      handleEvent: vi.fn().mockResolvedValue(true),
      now,
    });

    expect(provider.listSuppressions).toHaveBeenCalledWith(
      new Date(
        new Date("2026-10-07T09:00:00Z").getTime() -
          SUPPRESSION_POLL_OVERLAP_MS,
      ),
    );
    expect(appSettings.get(SUPPRESSION_CURSOR_KEY)).toBe(
      "2026-10-07T11:00:00.000Z",
    );
  });

  it("starts one day back when no cursor exists", async () => {
    const provider = createProvider([]);

    await pollProviderSuppressions({
      provider,
      handleEvent: vi.fn(),
      now,
    });

    expect(provider.listSuppressions).toHaveBeenCalledWith(
      new Date(
        new Date("2026-10-06T12:00:00Z").getTime() -
          SUPPRESSION_POLL_OVERLAP_MS,
      ),
    );
  });
});
