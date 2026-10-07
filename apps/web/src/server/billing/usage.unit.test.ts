import { beforeEach, describe, expect, it, vi } from "vitest";

const { ingest, findMany, envState } = vi.hoisted(() => ({
  ingest: vi.fn(),
  findMany: vi.fn(),
  envState: {
    current: {
      DODO_PAYMENTS_API_KEY: "test-key" as string | undefined,
      DODO_USAGE_METER_ID: "mtr_test" as string | undefined,
      DODO_USAGE_EVENT_NAME: "email.sent",
    },
  },
}));

vi.mock("~/env", () => ({
  get env() {
    return envState.current;
  },
}));
vi.mock("~/server/db", () => ({ db: { team: { findMany } } }));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./dodo-client", () => ({
  getDodoClient: () => ({ usageEvents: { ingest } }),
}));

import {
  buildUsageEvent,
  reportDailyUsage,
  usageEventId,
} from "./usage";

const NOW = new Date("2026-10-07T00:10:00.000Z");

describe("buildUsageEvent", () => {
  it("uses a deterministic event id per team and day", () => {
    expect(usageEventId(7, "2026-10-06")).toBe(
      "scribase-mail:usage:7:2026-10-06",
    );
  });

  it("sums all sent emails into the metered value", () => {
    const event = buildUsageEvent(
      {
        teamId: 7,
        customerId: "cus_1",
        date: "2026-10-06",
        transactional: 120,
        marketing: 30,
      },
      "email.sent",
      NOW,
    );

    expect(event).toEqual({
      event_id: "scribase-mail:usage:7:2026-10-06",
      customer_id: "cus_1",
      event_name: "email.sent",
      // Dodo only accepts timestamps within the last hour.
      timestamp: NOW.toISOString(),
      metadata: {
        emails: 150,
        transactional: 120,
        marketing: 30,
        usage_date: "2026-10-06",
        team_id: 7,
      },
    });
  });
});

describe("reportDailyUsage", () => {
  beforeEach(() => {
    ingest.mockReset();
    findMany.mockReset();
    envState.current = {
      DODO_PAYMENTS_API_KEY: "test-key",
      DODO_USAGE_METER_ID: "mtr_test",
      DODO_USAGE_EVENT_NAME: "email.sent",
    };
  });

  it("skips entirely when billing is not configured", async () => {
    envState.current = { ...envState.current, DODO_USAGE_METER_ID: undefined };

    const result = await reportDailyUsage({ now: NOW });

    expect(result).toEqual({ reported: 0, skipped: "not_configured" });
    expect(findMany).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("reports one event per team per day with sends, idempotently", async () => {
    findMany.mockResolvedValue([
      {
        id: 1,
        billingCustomerId: "cus_a",
        dailyEmailUsages: [
          { date: "2026-10-06", type: "TRANSACTIONAL", sent: 100 },
          { date: "2026-10-06", type: "TRANSACTIONAL", sent: 5 },
          { date: "2026-10-06", type: "MARKETING", sent: 10 },
          { date: "2026-10-05", type: "MARKETING", sent: 0 },
        ],
      },
      {
        id: 2,
        billingCustomerId: "cus_b",
        dailyEmailUsages: [
          { date: "2026-10-04", type: "TRANSACTIONAL", sent: 3 },
        ],
      },
    ]);
    ingest.mockResolvedValue({ ingested_count: 2 });

    const result = await reportDailyUsage({ now: NOW });

    expect(result).toEqual({ reported: 2 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          billingCustomerId: { not: null },
          plan: { not: "FREE" },
        },
      }),
    );
    const sent = ingest.mock.calls[0]![0].events;
    expect(sent.map((e: { event_id: string }) => e.event_id)).toEqual([
      "scribase-mail:usage:1:2026-10-06",
      "scribase-mail:usage:2:2026-10-04",
    ]);
    expect(sent[0].metadata.emails).toBe(115);
    expect(sent[1].customer_id).toBe("cus_b");
  });

  it("batches ingestion at 1,000 events per request", async () => {
    findMany.mockResolvedValue(
      Array.from({ length: 1001 }, (_, i) => ({
        id: i + 1,
        billingCustomerId: `cus_${i}`,
        dailyEmailUsages: [
          { date: "2026-10-06", type: "TRANSACTIONAL", sent: 1 },
        ],
      })),
    );
    ingest.mockResolvedValue({ ingested_count: 1 });

    const result = await reportDailyUsage({ now: NOW });

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls[0]![0].events).toHaveLength(1000);
    expect(ingest.mock.calls[1]![0].events).toHaveLength(1);
    expect(result.reported).toBe(1001);
  });

  it("propagates ingest failures so the job retries with the same ids", async () => {
    findMany.mockResolvedValue([
      {
        id: 1,
        billingCustomerId: "cus_a",
        dailyEmailUsages: [
          { date: "2026-10-06", type: "TRANSACTIONAL", sent: 1 },
        ],
      },
    ]);
    ingest.mockRejectedValue(new Error("network"));

    await expect(reportDailyUsage({ now: NOW })).rejects.toThrow("network");
  });
});
