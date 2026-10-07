import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EmailProvider,
  ProviderDeliveryEvent,
} from "~/server/provider/types";

const { mockDb, processed, appSettings } = vi.hoisted(() => {
  const processed = new Map<string, unknown>();
  const appSettings = new Map<string, string>();
  return {
    processed,
    appSettings,
    mockDb: {
      processedProviderLogEvent: {
        findMany: vi.fn(
          async ({ where }: { where: { id: { in: string[] } } }) =>
            where.id.in.filter((id) => processed.has(id)).map((id) => ({ id })),
        ),
        create: vi.fn(async ({ data }: { data: { id: string } }) => {
          processed.set(data.id, data);
          return data;
        }),
        deleteMany: vi.fn(async () => ({ count: 0 })),
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
      email: { findMany: vi.fn() },
      domain: { findMany: vi.fn() },
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
vi.mock("~/env", () => ({ env: { DELIVERY_LOG_POLL_CRON: "* * * * *" } }));
vi.mock("~/server/service/email-event-service", () => ({
  processEmailEvent: vi.fn(),
}));
vi.mock("~/server/provider", () => ({
  getEmailProvider: vi.fn(),
}));

import {
  DELIVERY_LOG_CURSOR_KEY,
  DELIVERY_LOG_POLL_OVERLAP_MS,
  ENSURE_LOGS_RETRY_MS,
  PROCESSED_LOG_EVENT_RETENTION_MS,
  pollProviderDeliveryLogs,
  resetDeliveryLogEnsureBackoff,
} from "./provider-delivery-log-poll-job";
import { DeliveryLogsNotConfiguredError } from "~/server/provider/oci/delivery-logs";

const now = new Date("2026-10-07T12:00:00Z");

function record(
  overrides: Partial<ProviderDeliveryEvent> = {},
): ProviderDeliveryEvent {
  return {
    id: "rec-1",
    action: "relay",
    timestamp: new Date("2026-10-07T11:59:00Z"),
    messageId: "em_1@acme.test",
    recipient: "user@example.com",
    smtpStatus: "250 ok",
    ...overrides,
  };
}

function createProvider(events: ProviderDeliveryEvent[], truncated = false) {
  return {
    listDeliveryEvents: vi.fn(async () => ({ events, truncated })),
    ensureDeliveryLogs: vi.fn(async () => ({ status: "enabled", created: [] })),
  } as unknown as EmailProvider & {
    listDeliveryEvents: ReturnType<typeof vi.fn>;
    ensureDeliveryLogs: ReturnType<typeof vi.fn>;
  };
}

describe("pollProviderDeliveryLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processed.clear();
    appSettings.clear();
    resetDeliveryLogEnsureBackoff();
    mockDb.email.findMany.mockResolvedValue([
      { id: "em_1", providerMessageId: "em_1@acme.test" },
    ]);
    mockDb.domain.findMany.mockResolvedValue([]);
  });

  it("maps relay, bounce and complaint records through the event pipeline", async () => {
    const provider = createProvider([
      record(),
      record({
        id: "rec-2",
        action: "bounce",
        bounceType: "hard",
        bounceCode: "5.1.1",
      }),
      record({ id: "rec-3", action: "complaint" }),
    ]);
    const handleEvent = vi.fn().mockResolvedValue(true);

    const result = await pollProviderDeliveryLogs({
      provider,
      handleEvent,
      now,
    });

    expect(mockDb.email.findMany).toHaveBeenCalledWith({
      where: { providerMessageId: { in: ["em_1@acme.test"] } },
      select: { id: true, providerMessageId: true },
    });
    expect(handleEvent.mock.calls.map((c) => c[0].eventType)).toEqual([
      "Delivery",
      "Bounce",
      "Complaint",
    ]);
    expect(handleEvent.mock.calls[1]![0]).toMatchObject({
      mail: { emailId: "em_1" },
      bounce: { bounceType: "Permanent" },
    });
    expect(result).toEqual({ seen: 3, emitted: 3, skipped: 0, failed: 0 });
    expect([...processed.keys()]).toEqual(["rec-1", "rec-2", "rec-3"]);
  });

  it("does not emit duplicates across overlapping polls", async () => {
    const provider = createProvider([record()]);
    const handleEvent = vi.fn().mockResolvedValue(true);

    await pollProviderDeliveryLogs({ provider, handleEvent, now });
    const second = await pollProviderDeliveryLogs({
      provider,
      handleEvent,
      now,
    });

    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ seen: 1, emitted: 0, skipped: 0, failed: 0 });
  });

  it("ignores open/click/unsubscribe and records unmatched emails as skipped", async () => {
    mockDb.email.findMany.mockResolvedValue([]);
    const provider = createProvider([
      record({ id: "o", action: "open" }),
      record({ id: "c", action: "click" }),
      record({ id: "u", action: "unsubscribe" }),
      record({ id: "foreign" }),
    ]);
    const handleEvent = vi.fn();

    const result = await pollProviderDeliveryLogs({
      provider,
      handleEvent,
      now,
    });

    expect(handleEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ seen: 1, emitted: 0, skipped: 1, failed: 0 });
    expect([...processed.keys()]).toEqual(["foreign"]);
  });

  it("retries records whose handling failed", async () => {
    const provider = createProvider([record()]);
    const handleEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(true);

    const first = await pollProviderDeliveryLogs({
      provider,
      handleEvent,
      now,
    });
    expect(first.failed).toBe(1);
    expect(processed.has("rec-1")).toBe(false);

    const second = await pollProviderDeliveryLogs({
      provider,
      handleEvent,
      now,
    });
    expect(second.emitted).toBe(1);
    expect(processed.has("rec-1")).toBe(true);
  });

  it("polls from the cursor minus the overlap and advances it to now", async () => {
    appSettings.set(DELIVERY_LOG_CURSOR_KEY, "2026-10-07T11:59:00.000Z");
    const provider = createProvider([]);

    await pollProviderDeliveryLogs({ provider, handleEvent: vi.fn(), now });

    expect(provider.listDeliveryEvents).toHaveBeenCalledWith(
      new Date(
        new Date("2026-10-07T11:59:00Z").getTime() -
          DELIVERY_LOG_POLL_OVERLAP_MS,
      ),
      now,
    );
    expect(appSettings.get(DELIVERY_LOG_CURSOR_KEY)).toBe(now.toISOString());
    expect(mockDb.processedProviderLogEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: {
          lt: new Date(now.getTime() - PROCESSED_LOG_EVENT_RETENTION_MS),
        },
      },
    });
  });

  it("caps the lookback at one day", async () => {
    appSettings.set(DELIVERY_LOG_CURSOR_KEY, "2026-09-01T00:00:00.000Z");
    const provider = createProvider([]);

    await pollProviderDeliveryLogs({ provider, handleEvent: vi.fn(), now });

    expect(provider.listDeliveryEvents).toHaveBeenCalledWith(
      new Date(
        new Date("2026-10-06T12:00:00Z").getTime() -
          DELIVERY_LOG_POLL_OVERLAP_MS,
      ),
      now,
    );
  });

  it("resumes from the last record when the search was truncated", async () => {
    appSettings.set(DELIVERY_LOG_CURSOR_KEY, "2026-10-07T11:00:00.000Z");
    const provider = createProvider(
      [record({ timestamp: new Date("2026-10-07T11:30:00Z") })],
      true,
    );

    await pollProviderDeliveryLogs({
      provider,
      handleEvent: vi.fn().mockResolvedValue(true),
      now,
    });

    expect(appSettings.get(DELIVERY_LOG_CURSOR_KEY)).toBe(
      "2026-10-07T11:30:00.000Z",
    );
  });

  it("skips quietly when the OCI API is not configured", async () => {
    const provider = createProvider([]);
    provider.listDeliveryEvents.mockRejectedValue(
      new DeliveryLogsNotConfiguredError(),
    );

    const result = await pollProviderDeliveryLogs({
      provider,
      handleEvent: vi.fn(),
      now,
    });

    expect(result).toEqual({ seen: 0, emitted: 0, skipped: 0, failed: 0 });
    expect(appSettings.has(DELIVERY_LOG_CURSOR_KEY)).toBe(false);
  });

  it("ensures delivery logs for verified domains and backs off on failure", async () => {
    mockDb.domain.findMany.mockResolvedValue([
      { id: 1, name: "ok.test", providerDomainId: "d1" },
      { id: 2, name: "broken.test", providerDomainId: "d2" },
    ]);
    const provider = createProvider([]);
    provider.ensureDeliveryLogs.mockImplementation(async (ref) => {
      if (ref.name === "broken.test") throw new Error("403 NotAuthorized");
      return { status: "enabled", created: [] };
    });

    await pollProviderDeliveryLogs({ provider, handleEvent: vi.fn(), now });
    await pollProviderDeliveryLogs({ provider, handleEvent: vi.fn(), now });

    expect(mockDb.domain.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "SUCCESS" } }),
    );
    const names = provider.ensureDeliveryLogs.mock.calls.map((c) => c[0].name);
    expect(names).toEqual(["ok.test", "broken.test", "ok.test"]);

    await pollProviderDeliveryLogs({
      provider,
      handleEvent: vi.fn(),
      now: new Date(now.getTime() + ENSURE_LOGS_RETRY_MS + 1),
    });
    expect(provider.ensureDeliveryLogs).toHaveBeenCalledTimes(5);
  });
});
