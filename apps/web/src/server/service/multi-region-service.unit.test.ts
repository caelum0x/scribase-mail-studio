/**
 * Unit tests for MultiRegionService.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  toOciRegion,
  toResendRegion,
  getSupportedResendRegions,
  getSmtpCredentialsForPool,
  RESEND_TO_OCI_REGION,
} from "~/server/service/multi-region-service";

vi.mock("~/server/logger/log", () => ({
  logger: { warn: vi.fn() },
}));

describe("MultiRegionService", () => {
  describe("toOciRegion", () => {
    it("should map us-east-1 to OCI us-ashburn-1", () => {
      expect(toOciRegion("us-east-1")).toBe("us-ashburn-1");
    });

    it("should map eu-west-1 to OCI eu-frankfurt-1", () => {
      expect(toOciRegion("eu-west-1")).toBe("eu-frankfurt-1");
    });

    it("should pass through unknown regions unchanged", () => {
      expect(toOciRegion("ap-sydney-1")).toBe("ap-sydney-1");
    });

    it("should pass through OCI region names unchanged", () => {
      expect(toOciRegion("eu-frankfurt-1")).toBe("eu-frankfurt-1");
    });
  });

  describe("toResendRegion", () => {
    it("should map OCI eu-frankfurt-1 to eu-west-1", () => {
      expect(toResendRegion("eu-frankfurt-1")).toBe("eu-west-1");
    });

    it("should pass through unknown OCI regions unchanged", () => {
      expect(toResendRegion("ap-sydney-1")).toBe("ap-sydney-1");
    });
  });

  describe("getSupportedResendRegions", () => {
    it("should return all mapped Resend region names", () => {
      const regions = getSupportedResendRegions();

      expect(regions).toContain("us-east-1");
      expect(regions).toContain("eu-west-1");
      expect(regions).toContain("sa-east-1");
      expect(regions).toContain("ap-northeast-1");
    });

    it("should match the keys of RESEND_TO_OCI_REGION", () => {
      expect(getSupportedResendRegions().sort()).toEqual(
        Object.keys(RESEND_TO_OCI_REGION).sort(),
      );
    });
  });

  describe("getSmtpCredentialsForPool", () => {
    beforeEach(() => {
      // Set default SMTP env vars
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.SMTP_USER = "user@example.com";
      process.env.SMTP_PASS = "defaultpass";
      process.env.SMTP_PORT = "587";
    });

    it("should return default credentials when pool is null", () => {
      const creds = getSmtpCredentialsForPool(null);

      expect(creds).not.toBeNull();
      expect(creds!.host).toBe("smtp.example.com");
      expect(creds!.poolName).toBeNull();
    });

    it("should return pool credentials when env vars are set", () => {
      process.env.OCI_SMTP_POOL_MYPOOL_HOST = "dedicated-smtp.oci.com";
      process.env.OCI_SMTP_POOL_MYPOOL_USER = "pool-user";
      process.env.OCI_SMTP_POOL_MYPOOL_PASS = "pool-pass";

      const creds = getSmtpCredentialsForPool("mypool");

      expect(creds!.host).toBe("dedicated-smtp.oci.com");
      expect(creds!.poolName).toBe("mypool");

      delete process.env.OCI_SMTP_POOL_MYPOOL_HOST;
      delete process.env.OCI_SMTP_POOL_MYPOOL_USER;
      delete process.env.OCI_SMTP_POOL_MYPOOL_PASS;
    });

    it("should fall back to default credentials when pool env vars are missing", () => {
      const creds = getSmtpCredentialsForPool("nonexistent-pool");

      expect(creds!.host).toBe("smtp.example.com");
      expect(creds!.poolName).toBeNull();
    });
  });
});
