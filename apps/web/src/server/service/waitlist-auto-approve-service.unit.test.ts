import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, sendMailMock, recordAuditMock } = vi.hoisted(() => ({
  dbMock: {
    user: { update: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  },
  sendMailMock: vi.fn(),
  recordAuditMock: vi.fn(),
}));

vi.mock("~/env", () => ({
  env: { NEXT_PUBLIC_IS_CLOUD: true, AUTO_APPROVE_WAITLIST: true, AUTO_APPROVE_DAILY_CAP: 25, ADMIN_EMAIL: "admin@scribase.com" },
}));
vi.mock("~/server/db", () => ({ db: dbMock }));
vi.mock("~/server/logger/log", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("~/server/mailer", () => ({ sendMail: sendMailMock }));
vi.mock("~/server/redis", () => ({ getRedis: vi.fn(), redisKey: (k: string) => k }));
vi.mock("~/server/service/audit-service", () => ({
  AuditAction: { WAITLIST_AUTO_APPROVED: "admin.waitlist_auto_approved" },
  AuditActorType: { SYSTEM: "SYSTEM" },
  recordAudit: recordAuditMock,
}));

import {
  decideAutoApproval,
  tryAutoApproveUser,
  type AutoApproveDeps,
} from "./waitlist-auto-approve-service";

function deps(overrides: Partial<AutoApproveDeps> = {}): AutoApproveDeps {
  let used = 0;
  const claimed = new Map<string, number>();
  return {
    enabled: true,
    isCloud: true,
    dailyCap: 2,
    resolveMx: async () => [{ exchange: "mx.acme.example", priority: 10 }],
    countActiveUsersOnDomain: async () => 0,
    reserveDailySlot: async (cap) => {
      if (used >= cap) return false;
      used++;
      return true;
    },
    releaseDailySlot: async () => {
      used--;
    },
    claimDomain: async (d, id) => {
      const holder = claimed.get(d);
      if (holder !== undefined && holder !== id) return false;
      claimed.set(d, id);
      return true;
    },
    releaseDomain: async (d) => {
      claimed.delete(d);
    },
    ...overrides,
  };
}

describe("decideAutoApproval", () => {
  it("approves a business domain with MX", async () => {
    expect(await decideAutoApproval({ id: 1, email: "ceo@acme.example" }, deps())).toEqual({
      approved: true, reason: "ok", domain: "acme.example",
    });
  });
  it("is off when disabled or not cloud", async () => {
    expect((await decideAutoApproval({ id: 1, email: "a@acme.example" }, deps({ enabled: false }))).reason).toBe("disabled");
    expect((await decideAutoApproval({ id: 1, email: "a@acme.example" }, deps({ isCloud: false }))).reason).toBe("not_cloud");
  });
  it("keeps free, disposable and no-MX sign-ups waitlisted", async () => {
    expect((await decideAutoApproval({ id: 1, email: "a@gmail.com" }, deps())).reason).toBe("free_provider");
    expect((await decideAutoApproval({ id: 1, email: "a@mailinator.com" }, deps())).reason).toBe("disposable");
    expect(
      (await decideAutoApproval({ id: 1, email: "a@acme.example" }, deps({ resolveMx: async () => [] }))).reason,
    ).toBe("no_mx");
  });
  it("allows only one account per domain", async () => {
    expect(
      (await decideAutoApproval({ id: 2, email: "b@acme.example" }, deps({ countActiveUsersOnDomain: async () => 1 }))).reason,
    ).toBe("domain_taken");
    const d = deps();
    expect((await decideAutoApproval({ id: 1, email: "a@acme.example" }, d)).approved).toBe(true);
    expect((await decideAutoApproval({ id: 2, email: "b@ACME.example" }, d)).reason).toBe("domain_taken");
  });
  it("stops at the daily cap and releases the domain claim", async () => {
    const d = deps({ dailyCap: 1 });
    expect((await decideAutoApproval({ id: 1, email: "a@one.example" }, d)).approved).toBe(true);
    expect((await decideAutoApproval({ id: 2, email: "a@two.example" }, d)).reason).toBe("daily_cap");
    // two.example was released, so a later day could take it
    expect(await d.claimDomain("two.example", 3)).toBe(true);
  });
  it("cap of 0 approves nobody", async () => {
    expect((await decideAutoApproval({ id: 1, email: "a@acme.example" }, deps({ dailyCap: 0 }))).reason).toBe("daily_cap");
  });
});

describe("tryAutoApproveUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.user.findUnique.mockResolvedValue({ teamUsers: [{ teamId: 1 }] });
  });

  it("flips isWaitlisted, audits and notifies the admin", async () => {
    dbMock.user.update.mockResolvedValue({});
    const res = await tryAutoApproveUser({ id: 7, email: "ceo@acme.example" }, "signup", deps());
    expect(res.approved).toBe(true);
    expect(dbMock.user.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { isWaitlisted: false } });
    expect(recordAuditMock).toHaveBeenCalledWith(
      { teamId: 1, actorType: "SYSTEM" },
      "admin.waitlist_auto_approved",
      expect.objectContaining({ targetType: "user", targetId: 7 }),
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0]![0]).toBe("admin@scribase.com");
  });

  it("does not touch the user when not approved", async () => {
    const res = await tryAutoApproveUser({ id: 7, email: "a@gmail.com" }, "signup", deps());
    expect(res.approved).toBe(false);
    expect(dbMock.user.update).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("fails closed when a dependency throws", async () => {
    const res = await tryAutoApproveUser(
      { id: 7, email: "a@acme.example" },
      "signup",
      deps({ countActiveUsersOnDomain: async () => { throw new Error("db down"); } }),
    );
    expect(res).toEqual({ approved: false, reason: "error" });
    expect(dbMock.user.update).not.toHaveBeenCalled();
  });

  it("releases the reservation when the user update fails", async () => {
    dbMock.user.update.mockRejectedValue(new Error("write failed"));
    const releaseDailySlot = vi.fn(async () => undefined);
    const releaseDomain = vi.fn(async () => undefined);
    const res = await tryAutoApproveUser({ id: 7, email: "a@acme.example" }, "signup", deps({ releaseDailySlot, releaseDomain }));
    expect(res.approved).toBe(false);
    expect(releaseDailySlot).toHaveBeenCalled();
    expect(releaseDomain).toHaveBeenCalledWith("acme.example", 7);
  });
});
