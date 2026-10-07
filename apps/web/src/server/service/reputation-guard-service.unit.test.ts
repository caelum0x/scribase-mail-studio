import { beforeEach, describe, expect, it, vi } from "vitest";

type UsageRow = {
  teamId: number;
  _sum: { sent: number | null; hardBounced: number | null; complained: number | null };
};

const { mockDb, state, notify } = vi.hoisted(() => {
  const state = {
    usage: [] as UsageRow[],
    blockedIds: [] as number[],
    updates: [] as { id: number; data: Record<string, unknown> }[],
    groupByArgs: null as unknown,
  };
  return {
    state,
    notify: vi.fn(async () => undefined),
    mockDb: {
      dailyEmailUsage: {
        groupBy: vi.fn(async (args: unknown) => {
          state.groupByArgs = args;
          return state.usage;
        }),
      },
      team: {
        findMany: vi.fn(async () => state.blockedIds.map((id) => ({ id }))),
        update: vi.fn(
          async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
            state.updates.push({ id: where.id, data });
            return { id: where.id, ...data };
          },
        ),
      },
    },
  };
});

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./team-service", () => ({
  TeamService: { invalidateTeamCache: vi.fn(async () => undefined) },
}));

import { runReputationGuard } from "./reputation-guard-service";

const now = new Date("2026-10-07T12:00:00Z");
const row = (
  teamId: number,
  sent: number,
  hardBounced: number,
  complained: number,
): UsageRow => ({ teamId, _sum: { sent, hardBounced, complained } });

describe("runReputationGuard", () => {
  beforeEach(() => {
    state.usage = [];
    state.blockedIds = [];
    state.updates = [];
    notify.mockClear();
  });

  it("looks at the last 7 days of usage", async () => {
    await runReputationGuard({ now, notify });
    expect(state.groupByArgs).toMatchObject({
      where: { date: { gte: "2026-10-01" } },
    });
  });

  it("pauses a team over the bounce threshold and records why", async () => {
    state.usage = [row(1, 1000, 50, 0)];

    const result = await runReputationGuard({ now, notify });

    expect(result).toEqual({ checked: 1, warned: 0, paused: 1 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      id: 1,
      data: { isBlocked: true, blockedAt: now },
    });
    expect(String(state.updates[0]!.data.blockedReason)).toContain("BOUNCE_RATE");
    expect(notify).toHaveBeenCalledWith(1, expect.objectContaining({ status: "paused" }));
  });

  it("warns without pausing in the warning band", async () => {
    state.usage = [row(2, 1000, 25, 0)];

    const result = await runReputationGuard({ now, notify });

    expect(result).toEqual({ checked: 1, warned: 1, paused: 0 });
    expect(state.updates).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(2, expect.objectContaining({ status: "warning" }));
  });

  it("leaves healthy and already-blocked teams alone", async () => {
    state.usage = [row(3, 1000, 1, 0), row(4, 1000, 90, 9)];
    state.blockedIds = [4];

    const result = await runReputationGuard({ now, notify });

    expect(result).toEqual({ checked: 1, warned: 0, paused: 0 });
    expect(state.updates).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("treats null sums as zero", async () => {
    state.usage = [{ teamId: 5, _sum: { sent: null, hardBounced: null, complained: null } }];

    const result = await runReputationGuard({ now, notify });

    expect(result).toEqual({ checked: 1, warned: 0, paused: 0 });
  });

  it("keeps going when a notification fails", async () => {
    state.usage = [row(6, 1000, 50, 0), row(7, 1000, 50, 0)];
    notify.mockRejectedValueOnce(new Error("smtp down"));

    const result = await runReputationGuard({ now, notify });

    expect(result.paused).toBe(2);
    expect(state.updates.map((u) => u.id)).toEqual([6, 7]);
  });
});
