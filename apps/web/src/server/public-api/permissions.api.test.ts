import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetTeamFromToken, mockRedis, mockDb } = vi.hoisted(() => ({
  mockGetTeamFromToken: vi.fn(),
  mockRedis: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
  mockDb: {
    campaign: { findFirst: vi.fn() },
  },
}));

vi.mock("~/server/public-api/auth", () => ({
  getTeamFromToken: mockGetTeamFromToken,
}));

vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
}));

vi.mock("~/server/db", () => ({ db: mockDb }));

vi.mock("~/utils/common", () => ({
  isSelfHosted: () => false,
}));

import { getApp } from "~/server/public-api/hono";
import {
  checkApiKeyAccess,
  isSendingRoute,
  toResourcePath,
} from "~/server/public-api/permissions";
import { assertCampaignInApiKeyDomain } from "~/server/public-api/api-utils";

function teamWith(permission: "FULL" | "SENDING", domainId: number | null) {
  return {
    id: 1,
    apiRateLimit: 100,
    apiKeyId: 11,
    apiKey: { domainId, permission },
  };
}

function buildApp() {
  const app = getApp();
  const ok = (c: any) => c.json({ ok: true });
  app.post("/v1/emails", ok);
  app.post("/v1/emails/batch", ok);
  app.get("/v1/emails/:id", ok);
  app.get("/v1/emails", ok);
  app.post("/v1/emails/:id/cancel", ok);
  app.patch("/v1/emails/:id", ok);
  app.get("/v1/domains", ok);
  app.post("/v1/domains", ok);
  app.delete("/v1/domains/:id", ok);
  app.get("/v1/contactBooks", ok);
  app.post("/v1/contactBooks/:id/contacts", ok);
  app.post("/v1/campaigns", ok);
  app.get("/v1/analytics/time-series", ok);
  return app;
}

async function call(method: string, path: string) {
  const app = buildApp();
  return app.request(`http://localhost/api${path}`, {
    method,
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  });
}

describe("API key permission enforcement", () => {
  beforeEach(() => {
    mockGetTeamFromToken.mockReset();
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);
    mockDb.campaign.findFirst.mockReset();
  });

  describe("sending-only keys", () => {
    beforeEach(() => {
      mockGetTeamFromToken.mockResolvedValue(teamWith("SENDING", null));
    });

    it.each([
      ["POST", "/v1/emails"],
      ["POST", "/v1/emails/batch"],
    ])("allows %s %s", async (method, path) => {
      const res = await call(method, path);
      expect(res.status).toBe(200);
    });

    it.each([
      ["GET", "/v1/emails/em_1"],
      ["GET", "/v1/emails"],
      ["PATCH", "/v1/emails/em_1"],
      ["POST", "/v1/emails/em_1/cancel"],
      ["GET", "/v1/domains"],
      ["POST", "/v1/domains"],
      ["DELETE", "/v1/domains/1"],
      ["GET", "/v1/contactBooks"],
      ["POST", "/v1/contactBooks/cb/contacts"],
      ["POST", "/v1/campaigns"],
      ["GET", "/v1/analytics/time-series"],
    ])("denies %s %s with 403", async (method, path) => {
      const res = await call(method, path);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toMatch(/only send emails/);
    });
  });

  describe("full-access keys", () => {
    beforeEach(() => {
      mockGetTeamFromToken.mockResolvedValue(teamWith("FULL", null));
    });

    it.each([
      ["GET", "/v1/emails/em_1"],
      ["POST", "/v1/domains"],
      ["GET", "/v1/contactBooks"],
      ["POST", "/v1/campaigns"],
    ])("allows %s %s", async (method, path) => {
      const res = await call(method, path);
      expect(res.status).toBe(200);
    });
  });

  describe("domain-restricted full-access keys", () => {
    beforeEach(() => {
      mockGetTeamFromToken.mockResolvedValue(teamWith("FULL", 7));
    });

    it.each([
      ["GET", "/v1/emails/em_1"],
      ["GET", "/v1/domains"],
      ["DELETE", "/v1/domains/7"],
      ["POST", "/v1/campaigns"],
      ["GET", "/v1/analytics/time-series"],
    ])("allows domain-scoped %s %s", async (method, path) => {
      const res = await call(method, path);
      expect(res.status).toBe(200);
    });

    it.each([
      ["POST", "/v1/domains"],
      ["GET", "/v1/contactBooks"],
      ["POST", "/v1/contactBooks/cb/contacts"],
    ])("denies team-wide %s %s with 403", async (method, path) => {
      const res = await call(method, path);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.message).toMatch(/restricted to a single domain/);
    });
  });

  it("treats a key with an unknown permission as sending-only", () => {
    expect(
      checkApiKeyAccess({ permission: undefined, domainId: null }, "GET", "/api/v1/domains"),
    ).toEqual({ allowed: false, reason: "SENDING_ONLY" });
  });

  it("applies the same policy to the Resend compat surface", () => {
    expect(isSendingRoute("POST", "/api/resend/emails")).toBe(true);
    expect(isSendingRoute("POST", "/api/resend/emails/batch")).toBe(true);
    expect(isSendingRoute("GET", "/api/resend/emails/abc")).toBe(false);
    expect(isSendingRoute("POST", "/api/resend/domains")).toBe(false);
    expect(toResourcePath("/api/resend")).toBe("/");
    expect(isSendingRoute("POST", "/api/v1/emails/")).toBe(true);
    expect(isSendingRoute("post", "/api/v1/emails")).toBe(true);
  });

  describe("assertCampaignInApiKeyDomain", () => {
    it("skips the lookup for unrestricted keys", async () => {
      await assertCampaignInApiKeyDomain("cmp_1", 1, null);
      expect(mockDb.campaign.findFirst).not.toHaveBeenCalled();
    });

    it("returns 404 for campaigns on another domain", async () => {
      mockDb.campaign.findFirst.mockResolvedValue(null);
      await expect(assertCampaignInApiKeyDomain("cmp_1", 1, 7)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(mockDb.campaign.findFirst).toHaveBeenCalledWith({
        where: { id: "cmp_1", teamId: 1, domainId: 7 },
        select: { id: true },
      });
    });

    it("passes for campaigns on the key's domain", async () => {
      mockDb.campaign.findFirst.mockResolvedValue({ id: "cmp_1" });
      await expect(assertCampaignInApiKeyDomain("cmp_1", 1, 7)).resolves.toBeUndefined();
    });
  });
});
