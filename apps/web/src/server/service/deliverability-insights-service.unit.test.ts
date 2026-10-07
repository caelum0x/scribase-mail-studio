/**
 * Unit tests for DeliverabilityInsightsService.
 * DNS calls and DB are mocked via vi.mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so these are available when vi.mock factory runs (hoisted before imports)
const { mockResolveTxt, mockResolveMx } = vi.hoisted(() => ({
  mockResolveTxt: vi.fn(),
  mockResolveMx: vi.fn(),
}));

vi.mock("dns", () => ({
  default: {
    promises: {
      resolveTxt: mockResolveTxt,
      resolveMx: mockResolveMx,
    },
  },
}));

vi.mock("~/server/db", () => ({
  db: {
    domain: {
      findUnique: vi.fn(),
    },
    dailyEmailUsage: {
      findMany: vi.fn(),
    },
  },
}));

import { db } from "~/server/db";
import { getDomainDeliverabilityInsights } from "~/server/service/deliverability-insights-service";

const mockedDb = db as unknown as {
  domain: { findUnique: ReturnType<typeof vi.fn> };
  dailyEmailUsage: { findMany: ReturnType<typeof vi.fn> };
};

const baseDomain = {
  id: 1,
  name: "example.com",
  dkimStatus: "SUCCESS",
  spfDetails: "SUCCESS",
  dmarcAdded: true,
  customReturnPath: null,
  returnPathStatus: null,
  trackingSubdomain: null,
  openTracking: false,
  clickTracking: false,
};

describe("DeliverabilityInsightsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedDb.domain.findUnique.mockResolvedValue(baseDomain);
    mockedDb.dailyEmailUsage.findMany.mockResolvedValue([]);
    mockResolveTxt.mockResolvedValue([]);
    mockResolveMx.mockResolvedValue([]);
  });

  it("should return insights with the domain name", async () => {
    const result = await getDomainDeliverabilityInsights(1, 1);

    expect(result.domainId).toBe(1);
    expect(result.domainName).toBe("example.com");
    expect(result.items).toBeInstanceOf(Array);
    expect(result.generatedAt).toBeInstanceOf(Date);
  });

  it("should flag missing DMARC as error", async () => {
    mockResolveTxt.mockResolvedValue([]);

    const result = await getDomainDeliverabilityInsights(1, 1);

    const dmarcItem = result.items.find((i) => i.key === "dmarc_missing");
    expect(dmarcItem).toBeDefined();
    expect(dmarcItem!.severity).toBe("error");
  });

  it("should flag DMARC policy=none as warning", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name.includes("_dmarc")) {
        return Promise.resolve([["v=DMARC1; p=none"]]);
      }
      return Promise.resolve([]);
    });

    const result = await getDomainDeliverabilityInsights(1, 1);

    const dmarcItem = result.items.find((i) => i.key === "dmarc_none");
    expect(dmarcItem).toBeDefined();
    expect(dmarcItem!.severity).toBe("warning");
  });

  it("should flag DMARC ok when policy is reject", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name.includes("_dmarc")) {
        return Promise.resolve([["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"]]);
      }
      return Promise.resolve([]);
    });

    const result = await getDomainDeliverabilityInsights(1, 1);

    const dmarcItem = result.items.find((i) => i.key === "dmarc_ok");
    expect(dmarcItem).toBeDefined();
    expect(dmarcItem!.severity).toBe("ok");
  });

  it("should flag missing SPF as error", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name.includes("_dmarc")) {
        return Promise.resolve([["v=DMARC1; p=reject"]]);
      }
      return Promise.resolve([]); // no SPF on root domain
    });

    const result = await getDomainDeliverabilityInsights(1, 1);

    const spfItem = result.items.find((i) => i.key === "spf_missing");
    expect(spfItem).toBeDefined();
    expect(spfItem!.severity).toBe("error");
  });

  it("should flag SPF without OCI as warning", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name === "example.com") {
        return Promise.resolve([["v=spf1 include:sendgrid.net ~all"]]);
      }
      return Promise.resolve([]);
    });

    const result = await getDomainDeliverabilityInsights(1, 1);

    const spfItem = result.items.find((i) => i.key === "spf_no_oci");
    expect(spfItem).toBeDefined();
    expect(spfItem!.severity).toBe("warning");
  });

  it("should flag SPF ok when OCI is included", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name === "example.com") {
        return Promise.resolve([
          ["v=spf1 include:spf_c.oracleemaildelivery.com ~all"],
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await getDomainDeliverabilityInsights(1, 1);

    const spfItem = result.items.find((i) => i.key === "spf_ok");
    expect(spfItem).toBeDefined();
    expect(spfItem!.severity).toBe("ok");
  });

  it("should flag high bounce rate as error", async () => {
    mockedDb.dailyEmailUsage.findMany.mockResolvedValue([
      { sent: 1000, delivered: 940, bounced: 60, complained: 0 },
    ]);

    const result = await getDomainDeliverabilityInsights(1, 1);

    const bounceItem = result.items.find((i) => i.key === "bounce_rate_critical");
    expect(bounceItem).toBeDefined();
    expect(bounceItem!.severity).toBe("error");
  });

  it("should aggregate stats from multiple usage rows", async () => {
    mockedDb.dailyEmailUsage.findMany.mockResolvedValue([
      { sent: 100, delivered: 90, bounced: 5, complained: 1 },
      { sent: 200, delivered: 190, bounced: 3, complained: 0 },
    ]);

    const result = await getDomainDeliverabilityInsights(1, 1);

    expect(result.stats.sent).toBe(300);
    expect(result.stats.bounced).toBe(8);
    expect(result.stats.complained).toBe(1);
  });

  it("should throw when the domain is not found", async () => {
    mockedDb.domain.findUnique.mockResolvedValue(null);

    await expect(getDomainDeliverabilityInsights(1, 999)).rejects.toThrow(
      "Domain 999 not found",
    );
  });
});
