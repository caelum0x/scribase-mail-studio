import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    teamUser: { findFirst: vi.fn() },
    team: { update: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/auth", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
}));
vi.mock("~/server/service/webhook-service", () => ({}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getChildLogger: vi.fn(() => ({})),
  withLogger: (_logger: unknown, fn: () => unknown) => fn(),
}));

import { createCallerFactory } from "~/server/api/trpc";
import { teamRouter } from "~/server/api/routers/team";

const createCaller = createCallerFactory(teamRouter);

function getContext() {
  return {
    db: mockDb,
    headers: new Headers(),
    session: {
      user: {
        id: 1,
        email: "admin@example.com",
        isWaitlisted: false,
        isAdmin: false,
        isBetaUser: true,
      },
    },
  } as any;
}

describe("teamRouter dedicated sending pool", () => {
  beforeEach(() => {
    mockDb.teamUser.findFirst.mockReset();
    mockDb.team.update.mockReset();
    mockDb.team.findUnique.mockReset();
    mockDb.auditLog.create.mockReset();

    mockDb.teamUser.findFirst.mockResolvedValue({
      teamId: 1,
      userId: 1,
      role: "ADMIN",
      team: { id: 1, name: "Team One", requireTwoFactor: false },
    });
  });

  it("persists the pool name and records an audit entry", async () => {
    mockDb.team.update.mockResolvedValue({});

    const caller = createCaller(getContext());
    const result = await caller.setSendingPool({ sendingPool: "highvol" });

    expect(result).toEqual({ sendingPool: "highvol" });
    expect(mockDb.team.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { sendingPool: "highvol" },
    });
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("clears the pool when null is passed, reverting to the shared relay", async () => {
    mockDb.team.update.mockResolvedValue({});

    const caller = createCaller(getContext());
    await caller.setSendingPool({ sendingPool: null });

    expect(mockDb.team.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { sendingPool: null },
    });
  });

  it("returns the team's current sending pool", async () => {
    mockDb.team.findUnique.mockResolvedValue({ sendingPool: "highvol" });

    const caller = createCaller(getContext());
    const result = await caller.getSendingPool();

    expect(result).toEqual({ sendingPool: "highvol" });
    expect(mockDb.team.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { sendingPool: true },
    });
  });

  it("rejects setSendingPool for non-admin team members", async () => {
    mockDb.teamUser.findFirst.mockResolvedValue({
      teamId: 1,
      userId: 1,
      role: "MEMBER",
      team: { id: 1, name: "Team One", requireTwoFactor: false },
    });

    const caller = createCaller(getContext());

    await expect(
      caller.setSendingPool({ sendingPool: "highvol" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mockDb.team.update).not.toHaveBeenCalled();
  });
});
