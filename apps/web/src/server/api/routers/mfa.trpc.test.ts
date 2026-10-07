/**
 * tRPC tests for the MFA router.
 * All service and DB calls are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockTotpService = vi.hoisted(() => ({
  generateEnrollment: vi.fn(),
  confirmEnrollment: vi.fn(),
  verifyChallenge: vi.fn(),
  verifyRecoveryCode: vi.fn(),
  disableTotp: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  getRemainingRecoveryCodeCount: vi.fn(),
}));

const mockAuditService = vi.hoisted(() => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
  userAuditCtx: vi.fn(() => ({
    teamId: 1,
    actorType: "USER",
    actorUserId: 1,
    ipAddress: null,
    userAgent: null,
  })),
  AuditAction: {
    MFA_ENROLLED: "mfa.enrolled",
    MFA_DISABLED: "mfa.disabled",
    MFA_ADMIN_RESET: "mfa.admin_reset",
    MFA_CHALLENGE_PASSED: "mfa.challenge_passed",
    MFA_RECOVERY_USED: "mfa.recovery_used",
    REQUIRE_2FA_CHANGED: "team.require_2fa_changed",
  },
  AuditActorType: {
    USER: "USER",
    API_KEY: "API_KEY",
    SYSTEM: "SYSTEM",
  },
}));

vi.mock("~/server/service/totp-service", () => mockTotpService);
vi.mock("~/server/service/audit-service", () => mockAuditService);
vi.mock("~/server/auth", () => ({ getServerAuthSession: vi.fn() }));

vi.mock("~/server/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
    },
    session: {
      updateMany: vi.fn(),
    },
    teamUser: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    team: {
      update: vi.fn(),
    },
  },
}));

import { db } from "~/server/db";
import { createCallerFactory } from "~/server/api/trpc";
import { mfaRouter } from "~/server/api/routers/mfa";

const mockedDb = db as any;
const createCaller = createCallerFactory(mfaRouter);

function ctx(opts?: { userId?: number; totpEnabled?: boolean }) {
  return {
    db,
    headers: new Headers(),
    session: {
      user: {
        id: opts?.userId ?? 1,
        email: "user@test.com",
        isWaitlisted: false,
        isAdmin: false,
        isBetaUser: false,
        totpEnabled: opts?.totpEnabled ?? false,
      },
    },
  } as any;
}

describe("mfaRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedDb.user.findUnique.mockResolvedValue({ email: "user@test.com", totpEnabled: false });
    mockedDb.session.updateMany.mockResolvedValue({ count: 1 });
    mockedDb.teamUser.findFirst.mockResolvedValue({ teamId: 1 });
    mockedDb.teamUser.findUnique.mockResolvedValue({ teamId: 1, userId: 2, role: "MEMBER" });
    mockedDb.team.update.mockResolvedValue({});
  });

  // ─── startEnrollment ───────────────────────────────────────────────────────

  describe("startEnrollment", () => {
    it("should return secret and QR when user has no TOTP", async () => {
      mockTotpService.generateEnrollment.mockResolvedValue({
        secret: "JBSWY3DPEHPK3PXP",
        qrDataUri: "data:image/png;base64,...",
        otpauthUrl: "otpauth://totp/...",
      });

      const caller = createCaller(ctx());
      const result = await caller.startEnrollment();

      expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
      expect(result.qrDataUri).toMatch(/^data:image\/png;base64,/);
    });

    it("should throw when TOTP is already enabled", async () => {
      mockedDb.user.findUnique.mockResolvedValue({
        email: "user@test.com",
        totpEnabled: true,
      });

      const caller = createCaller(ctx({ totpEnabled: true }));
      await expect(caller.startEnrollment()).rejects.toThrow(TRPCError);
    });
  });

  // ─── confirmEnrollment ─────────────────────────────────────────────────────

  describe("confirmEnrollment", () => {
    it("should return recovery codes on success", async () => {
      mockTotpService.confirmEnrollment.mockResolvedValue({
        recoveryCodes: ["code1", "code2"],
      });

      const caller = createCaller(ctx());
      const result = await caller.confirmEnrollment({
        secret: "JBSWY3DPEHPK3PXP",
        token: "123456",
      });

      expect(result.recoveryCodes).toHaveLength(2);
      expect(mockedDb.session.updateMany).toHaveBeenCalled();
    });

    it("should wrap service errors as TRPCError", async () => {
      mockTotpService.confirmEnrollment.mockRejectedValue(
        new Error("Invalid TOTP token"),
      );

      const caller = createCaller(ctx());
      await expect(
        caller.confirmEnrollment({ secret: "X", token: "000000" }),
      ).rejects.toThrow(TRPCError);
    });
  });

  // ─── verifyChallenge ───────────────────────────────────────────────────────

  describe("verifyChallenge", () => {
    it("should mark session verified on valid token", async () => {
      mockTotpService.verifyChallenge.mockResolvedValue(true);

      const caller = createCaller(ctx());
      const result = await caller.verifyChallenge({ token: "123456" });

      expect(result.verified).toBe(true);
      expect(mockedDb.session.updateMany).toHaveBeenCalled();
    });

    it("should throw on invalid token", async () => {
      mockTotpService.verifyChallenge.mockResolvedValue(false);

      const caller = createCaller(ctx());
      await expect(
        caller.verifyChallenge({ token: "000000" }),
      ).rejects.toThrow(TRPCError);
    });
  });

  // ─── verifyRecoveryCode ────────────────────────────────────────────────────

  describe("verifyRecoveryCode", () => {
    it("should mark session verified on valid recovery code", async () => {
      mockTotpService.verifyRecoveryCode.mockResolvedValue(true);

      const caller = createCaller(ctx());
      const result = await caller.verifyRecoveryCode({ code: "validcode1234567890" });

      expect(result.verified).toBe(true);
    });

    it("should throw on invalid recovery code", async () => {
      mockTotpService.verifyRecoveryCode.mockResolvedValue(false);

      const caller = createCaller(ctx());
      await expect(
        caller.verifyRecoveryCode({ code: "wrongcode" }),
      ).rejects.toThrow(TRPCError);
    });
  });

  // ─── disable ──────────────────────────────────────────────────────────────

  describe("disable", () => {
    it("should disable TOTP when token is valid", async () => {
      mockTotpService.verifyChallenge.mockResolvedValue(true);

      const caller = createCaller(ctx());
      const result = await caller.disable({ token: "123456" });

      expect(result.disabled).toBe(true);
      expect(mockTotpService.disableTotp).toHaveBeenCalledWith(1);
    });

    it("should throw when token is invalid", async () => {
      mockTotpService.verifyChallenge.mockResolvedValue(false);

      const caller = createCaller(ctx());
      await expect(caller.disable({ token: "000000" })).rejects.toThrow(TRPCError);
    });
  });

  // ─── getStatus ────────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("should return totpEnabled: true when enabled", async () => {
      mockedDb.user.findUnique.mockResolvedValue({ totpEnabled: true });

      const caller = createCaller(ctx({ totpEnabled: true }));
      const result = await caller.getStatus();

      expect(result.totpEnabled).toBe(true);
    });

    it("should return totpEnabled: false when not enrolled", async () => {
      mockedDb.user.findUnique.mockResolvedValue({ totpEnabled: false });

      const caller = createCaller(ctx());
      const result = await caller.getStatus();

      expect(result.totpEnabled).toBe(false);
    });
  });
});
