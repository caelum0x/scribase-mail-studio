/**
 * Unit tests for AuditService.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/server/db", () => ({
  db: {
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("~/server/logger/log", () => ({
  logger: {
    error: vi.fn(),
  },
}));

import { db } from "~/server/db";
import {
  recordAudit,
  userAuditCtx,
  apiKeyAuditCtx,
  AuditAction,
  AuditActorType,
} from "~/server/service/audit-service";

const mockedDb = db as {
  auditLog: {
    create: ReturnType<typeof vi.fn>;
  };
};

describe("AuditService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedDb.auditLog.create.mockResolvedValue({});
  });

  describe("recordAudit", () => {
    it("should write an audit log row", async () => {
      const ctx = userAuditCtx(1, 42, { ip: "1.2.3.4", ua: "test-agent" });

      await recordAudit(ctx, AuditAction.API_KEY_CREATED, {
        targetType: "api_key",
        targetId: 7,
        metadata: { name: "prod-key" },
      });

      expect(mockedDb.auditLog.create).toHaveBeenCalledWith({
        data: {
          teamId: 1,
          actorType: AuditActorType.USER,
          actorUserId: 42,
          actorApiKeyId: null,
          action: "api_key.created",
          targetType: "api_key",
          targetId: "7",
          metadata: { name: "prod-key" },
          ipAddress: "1.2.3.4",
          userAgent: "test-agent",
        },
      });
    });

    it("should not throw when the DB call fails", async () => {
      mockedDb.auditLog.create.mockRejectedValue(new Error("DB down"));

      await expect(
        recordAudit(
          userAuditCtx(1, 1),
          AuditAction.SIGN_IN,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("userAuditCtx", () => {
    it("should build a USER actor context", () => {
      const ctx = userAuditCtx(10, 20, { ip: "5.5.5.5" });

      expect(ctx).toEqual({
        teamId: 10,
        actorType: AuditActorType.USER,
        actorUserId: 20,
        actorApiKeyId: undefined,
        ipAddress: "5.5.5.5",
        userAgent: null,
      });
    });
  });

  describe("apiKeyAuditCtx", () => {
    it("should build an API_KEY actor context", () => {
      const ctx = apiKeyAuditCtx(5, 99);

      expect(ctx).toEqual({
        teamId: 5,
        actorType: AuditActorType.API_KEY,
        actorApiKeyId: 99,
        ipAddress: null,
        userAgent: null,
      });
    });
  });
});
