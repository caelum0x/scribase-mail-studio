/**
 * Unit tests for TotpService (otplib v13 async API).
 * All DB calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing the service
vi.mock("~/server/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { db } from "~/server/db";
import {
  generateEnrollment,
  confirmEnrollment,
  verifyChallenge,
  verifyRecoveryCode,
  disableTotp,
  regenerateRecoveryCodes,
  getRemainingRecoveryCodeCount,
} from "~/server/service/totp-service";
import { generateSecret, generate } from "otplib";

const mockedDb = db as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

describe("TotpService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedDb.user.update.mockResolvedValue({});
  });

  // ─── generateEnrollment ────────────────────────────────────────────────────

  describe("generateEnrollment", () => {
    it("should return a secret, otpauthUrl, and QR data URI", async () => {
      const result = await generateEnrollment(1, "test@example.com");

      expect(typeof result.secret).toBe("string");
      expect(result.secret.length).toBeGreaterThan(0);
      expect(result.otpauthUrl).toContain("otpauth://totp/");
      expect(result.qrDataUri).toMatch(/^data:image\/png;base64,/);
    });

    it("should save the unactivated secret to the user row", async () => {
      await generateEnrollment(1, "test@example.com");

      expect(mockedDb.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({ totpEnabled: false }),
        }),
      );
    });
  });

  // ─── confirmEnrollment ────────────────────────────────────────────────────

  describe("confirmEnrollment", () => {
    it("should confirm enrollment when the token is valid", async () => {
      const secret = generateSecret();
      mockedDb.user.findUnique.mockResolvedValue({ totpSecret: secret });
      const validToken = await generate({ secret });

      const result = await confirmEnrollment(1, secret, validToken);

      expect(result.recoveryCodes).toHaveLength(10);
      expect(result.recoveryCodes[0]).toHaveLength(20); // 10 bytes → 20 hex chars
    });

    it("should throw when there is no pending secret", async () => {
      mockedDb.user.findUnique.mockResolvedValue({ totpSecret: null });

      await expect(
        confirmEnrollment(1, "somesecret", "123456"),
      ).rejects.toThrow("No pending TOTP enrollment");
    });

    it("should throw when the secret mismatches", async () => {
      mockedDb.user.findUnique.mockResolvedValue({ totpSecret: "DIFFERENT" });

      await expect(
        confirmEnrollment(1, "SOMESECRET", "123456"),
      ).rejects.toThrow("Secret mismatch");
    });

    it("should throw when the token is invalid", async () => {
      const secret = generateSecret();
      mockedDb.user.findUnique.mockResolvedValue({ totpSecret: secret });

      await expect(
        confirmEnrollment(1, secret, "000000"),
      ).rejects.toThrow("Invalid TOTP token");
    });
  });

  // ─── verifyChallenge ──────────────────────────────────────────────────────

  describe("verifyChallenge", () => {
    it("should return true for a valid token", async () => {
      const secret = generateSecret();
      mockedDb.user.findUnique.mockResolvedValue({
        totpSecret: secret,
        totpEnabled: true,
      });
      const token = await generate({ secret });

      expect(await verifyChallenge(1, token)).toBe(true);
    });

    it("should return false for an invalid token", async () => {
      const secret = generateSecret();
      mockedDb.user.findUnique.mockResolvedValue({
        totpSecret: secret,
        totpEnabled: true,
      });

      expect(await verifyChallenge(1, "000000")).toBe(false);
    });

    it("should return false when TOTP is not enabled", async () => {
      mockedDb.user.findUnique.mockResolvedValue({
        totpSecret: null,
        totpEnabled: false,
      });

      expect(await verifyChallenge(1, "123456")).toBe(false);
    });
  });

  // ─── verifyRecoveryCode ───────────────────────────────────────────────────

  describe("verifyRecoveryCode", () => {
    it("should return true and burn the code when valid", async () => {
      // Generate a known code and its hash
      const rawCode = "aabbccddeeff001122";
      const { createHash } = await import("crypto");
      const hash = createHash("sha256").update(rawCode).digest("hex");

      mockedDb.user.findUnique.mockResolvedValue({
        totpEnabled: true,
        totpRecoveryCodes: [hash, "someotherhash"],
      });

      const result = await verifyRecoveryCode(1, rawCode);

      expect(result).toBe(true);
      expect(mockedDb.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totpRecoveryCodes: ["someotherhash"],
          }),
        }),
      );
    });

    it("should return false for an unknown code", async () => {
      mockedDb.user.findUnique.mockResolvedValue({
        totpEnabled: true,
        totpRecoveryCodes: ["somehash"],
      });

      expect(await verifyRecoveryCode(1, "wrongcode")).toBe(false);
      expect(mockedDb.user.update).not.toHaveBeenCalled();
    });

    it("should return false when TOTP is not enabled", async () => {
      mockedDb.user.findUnique.mockResolvedValue({
        totpEnabled: false,
        totpRecoveryCodes: [],
      });

      expect(await verifyRecoveryCode(1, "anycode")).toBe(false);
    });
  });

  // ─── disableTotp ─────────────────────────────────────────────────────────

  describe("disableTotp", () => {
    it("should clear all TOTP fields", async () => {
      await disableTotp(1);

      expect(mockedDb.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          totpSecret: null,
          totpEnabled: false,
          totpRecoveryCodes: null,
        },
      });
    });
  });

  // ─── regenerateRecoveryCodes ──────────────────────────────────────────────

  describe("regenerateRecoveryCodes", () => {
    it("should return 10 new codes when TOTP is enabled", async () => {
      mockedDb.user.findUnique.mockResolvedValue({ totpEnabled: true });

      const codes = await regenerateRecoveryCodes(1);

      expect(codes).toHaveLength(10);
      codes.forEach((c) => expect(c).toHaveLength(20));
    });

    it("should throw when TOTP is not enabled", async () => {
      mockedDb.user.findUnique.mockResolvedValue({ totpEnabled: false });

      await expect(regenerateRecoveryCodes(1)).rejects.toThrow(
        "TOTP is not enabled",
      );
    });
  });

  // ─── getRemainingRecoveryCodeCount ────────────────────────────────────────

  describe("getRemainingRecoveryCodeCount", () => {
    it("should return the number of remaining codes", async () => {
      mockedDb.user.findUnique.mockResolvedValue({
        totpRecoveryCodes: ["a", "b", "c"],
      });

      expect(await getRemainingRecoveryCodeCount(1)).toBe(3);
    });

    it("should return 0 when no codes remain", async () => {
      mockedDb.user.findUnique.mockResolvedValue({ totpRecoveryCodes: null });

      expect(await getRemainingRecoveryCodeCount(1)).toBe(0);
    });
  });
});
