import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, mockLogger } = vi.hoisted(() => ({
  mockEnv: {
    REACHER_ENABLED: true,
    REACHER_API_URL: "http://reacher.internal:8080" as string | undefined,
    REACHER_API_KEY: undefined as string | undefined,
    REACHER_TIMEOUT_MS: 4000,
    REACHER_BLOCK_VERDICTS: "invalid",
    REACHER_SELFTEST_EMAIL: "reacher-selftest-probe-does-not-exist@gmail.com",
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockResolveMx = vi.fn();

vi.mock("~/env", () => ({ env: mockEnv }));
vi.mock("~/server/logger/log", () => ({ logger: mockLogger }));
vi.mock("node:dns/promises", () => ({ resolveMx: (domain: string) => mockResolveMx(domain) }));

import {
  AddressVerificationService,
  _setReacherHealthCacheForTests,
} from "./address-verification-service";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe("AddressVerificationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.REACHER_ENABLED = true;
    mockEnv.REACHER_API_URL = "http://reacher.internal:8080";
    mockEnv.REACHER_API_KEY = undefined;
    mockEnv.REACHER_TIMEOUT_MS = 4000;
    mockEnv.REACHER_BLOCK_VERDICTS = "invalid";
    mockEnv.REACHER_SELFTEST_EMAIL = "reacher-selftest-probe-does-not-exist@gmail.com";
    mockResolveMx.mockReset();
    mockResolveMx.mockResolvedValue([{ exchange: "mx.example.com", priority: 10 }]);
    // Pre-warm the self-test cache as "healthy" so tests that aren't about
    // the self-test gate itself exercise checkOne()/liteCheck() directly,
    // without an extra probe call consuming the test's own fetch mock.
    // Tests that target the self-test gate explicitly reset/override this.
    _setReacherHealthCacheForTests({ healthy: true, checkedAt: Date.now() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks an address reacher reports as invalid", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ is_reachable: "invalid" }),
    );

    const result = await AddressVerificationService.checkAddress(
      "nobody@example.com",
    );

    expect(result).toEqual({
      blocked: true,
      verdict: "invalid",
      method: "reacher_smtp",
    });
  });

  it("does not block safe, risky, or unknown verdicts by default", async () => {
    for (const verdict of ["safe", "risky", "unknown"]) {
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse({ is_reachable: verdict }),
      );
      const result = await AddressVerificationService.checkAddress(
        "person@example.com",
      );
      expect(result).toEqual({ blocked: false, verdict, method: "reacher_smtp" });
    }
  });

  it("sends the request to the configured reacher backend with the right shape", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse({ is_reachable: "safe" }));

    await AddressVerificationService.checkAddress("Person@Example.com");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://reacher.internal:8080/v0/check_email",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ to_email: "person@example.com" }),
      }),
    );
  });

  it("sends a bearer token when REACHER_API_KEY is configured", async () => {
    mockEnv.REACHER_API_KEY = "secret-token";
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse({ is_reachable: "safe" }));

    await AddressVerificationService.checkAddress("person@example.com");

    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
  });

  it("fails open (does not block) when the backend is unreachable", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await AddressVerificationService.checkAddress(
      "person@example.com",
    );

    expect(result).toEqual({ blocked: false, verdict: "unknown", method: "reacher_smtp" });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("fails open when the request times out", async () => {
    vi.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          reject(new DOMException("aborted", "AbortError"));
        }),
    );

    const result = await AddressVerificationService.checkAddress(
      "person@example.com",
    );

    expect(result).toEqual({ blocked: false, verdict: "unknown", method: "reacher_smtp" });
  });

  it("fails open when the backend returns a non-2xx response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({}, false, 500),
    );

    const result = await AddressVerificationService.checkAddress(
      "person@example.com",
    );

    expect(result).toEqual({ blocked: false, verdict: "unknown", method: "reacher_smtp" });
  });

  it("falls back to the lite check (never calls fetch) when reacher is disabled", async () => {
    mockEnv.REACHER_ENABLED = false;
    const fetchSpy = vi.spyOn(global, "fetch");

    const result = await AddressVerificationService.checkAddress(
      "person@example.com",
    );

    expect(result).toEqual({ blocked: false, verdict: "safe", method: "lite_fallback" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockResolveMx).toHaveBeenCalledWith("example.com");
  });

  it("falls back to the lite check when no backend URL is configured", async () => {
    mockEnv.REACHER_API_URL = undefined;
    const fetchSpy = vi.spyOn(global, "fetch");

    const result = await AddressVerificationService.checkAddress(
      "person@example.com",
    );

    expect(result).toEqual({ blocked: false, verdict: "safe", method: "lite_fallback" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("lite fallback (syntax + MX + disposable, no SMTP)", () => {
    beforeEach(() => {
      mockEnv.REACHER_ENABLED = false;
      mockEnv.REACHER_API_URL = undefined;
    });

    it("blocks malformed addresses as invalid without a DNS lookup", async () => {
      const result = await AddressVerificationService.checkAddress("not-an-email");
      expect(result).toEqual({ blocked: true, verdict: "invalid", method: "lite_fallback" });
      expect(mockResolveMx).not.toHaveBeenCalled();
    });

    it("rejects a syntactically-invalid local part (space) as invalid without a DNS lookup", async () => {
      const result = await AddressVerificationService.checkAddress(
        "john doe@example.com",
      );
      expect(result).toEqual({ blocked: true, verdict: "invalid", method: "lite_fallback" });
      expect(mockResolveMx).not.toHaveBeenCalled();
    });

    it("rejects a local part with consecutive dots as invalid", async () => {
      const result = await AddressVerificationService.checkAddress(
        "john..doe@example.com",
      );
      expect(result).toEqual({ blocked: true, verdict: "invalid", method: "lite_fallback" });
      expect(mockResolveMx).not.toHaveBeenCalled();
    });

    it("rejects a leading-dot local part as invalid", async () => {
      const result = await AddressVerificationService.checkAddress(".john@example.com");
      expect(result).toEqual({ blocked: true, verdict: "invalid", method: "lite_fallback" });
    });

    it("rejects a local part over the RFC 5321 64-octet limit as invalid", async () => {
      const result = await AddressVerificationService.checkAddress(
        `${"a".repeat(65)}@example.com`,
      );
      expect(result).toEqual({ blocked: true, verdict: "invalid", method: "lite_fallback" });
      expect(mockResolveMx).not.toHaveBeenCalled();
    });

    it("accepts a quoted-string local part", async () => {
      const result = await AddressVerificationService.checkAddress(
        '"john doe"@example.com',
      );
      expect(result).toEqual({ blocked: false, verdict: "safe", method: "lite_fallback" });
    });

    it("accepts a syntactically-valid, non-disposable address with a usable MX record as safe", async () => {
      const result = await AddressVerificationService.checkAddress(
        "valid.person+tag@example.com",
      );
      expect(result).toEqual({ blocked: false, verdict: "safe", method: "lite_fallback" });
      expect(mockResolveMx).toHaveBeenCalledWith("example.com");
    });

    it("flags a known disposable domain as risky (not blocked by default)", async () => {
      const result = await AddressVerificationService.checkAddress("a@mailinator.com");
      expect(result).toEqual({ blocked: false, verdict: "risky", method: "lite_fallback" });
      expect(mockResolveMx).not.toHaveBeenCalled();
    });

    it("rejects a known disposable-domain address when risky is blocked", async () => {
      mockEnv.REACHER_BLOCK_VERDICTS = "invalid,risky";
      const result = await AddressVerificationService.checkAddress("a@mailinator.com");
      expect(result).toEqual({ blocked: true, verdict: "risky", method: "lite_fallback" });
      expect(mockResolveMx).not.toHaveBeenCalled();
    });

    it("blocks a syntactically-valid domain with no MX record", async () => {
      mockResolveMx.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
      const result = await AddressVerificationService.checkAddress("a@no-such-domain-xyz.example");
      expect(result).toEqual({ blocked: true, verdict: "invalid", method: "lite_fallback" });
    });

    it("fails open (unknown, not blocked) when the MX lookup itself errors", async () => {
      mockResolveMx.mockRejectedValue(new Error("DNS server timeout"));
      const result = await AddressVerificationService.checkAddress("person@example.com");
      expect(result).toEqual({ blocked: false, verdict: "unknown", method: "lite_fallback" });
    });

    it("reports the degraded-confidence lite_fallback method, not a false full-verification claim, when SMTP probing is unavailable", async () => {
      const result = await AddressVerificationService.checkAddress("person@example.com");
      expect(result.verdict).toBe("safe");
      // The honest signal: this "safe" did NOT come from a real SMTP probe.
      expect(result.method).toBe("lite_fallback");
      expect(result.method).not.toBe("reacher_smtp");
    });

    it("passes a real-looking domain with a usable MX record as safe", async () => {
      const result = await AddressVerificationService.checkAddress("person@example.com");
      expect(result).toEqual({ blocked: false, verdict: "safe", method: "lite_fallback" });
    });

    it("respects REACHER_BLOCK_VERDICTS for lite-path verdicts too", async () => {
      mockEnv.REACHER_BLOCK_VERDICTS = "invalid,risky";
      const result = await AddressVerificationService.checkAddress("a@mailinator.com");
      expect(result).toEqual({ blocked: true, verdict: "risky", method: "lite_fallback" });
    });
  });

  it("checks multiple unique, normalized addresses in one batch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        const verdict =
          body.to_email === "bad@example.com" ? "invalid" : "safe";
        return jsonResponse({ is_reachable: verdict });
      });

    const results = await AddressVerificationService.checkAddresses([
      "Good@Example.com",
      "good@example.com",
      "bad@example.com",
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(results["good@example.com"]).toEqual({
      blocked: false,
      verdict: "safe",
      method: "reacher_smtp",
    });
    expect(results["bad@example.com"]).toEqual({
      blocked: true,
      verdict: "invalid",
      method: "reacher_smtp",
    });
  });

  it("respects a custom REACHER_BLOCK_VERDICTS list", async () => {
    mockEnv.REACHER_BLOCK_VERDICTS = "invalid,risky";
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ is_reachable: "risky" }),
    );

    const result = await AddressVerificationService.checkAddress(
      "person@example.com",
    );

    expect(result).toEqual({ blocked: true, verdict: "risky", method: "reacher_smtp" });
  });

  it("returns an empty result for an empty address list without calling fetch", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");

    const results = await AddressVerificationService.checkAddresses([]);

    expect(results).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("self-test / auto-demote guard (Reacher configured but may be structurally broken)", () => {
    beforeEach(() => {
      // Force every test in this block to run its own real probe instead of
      // inheriting the outer beforeEach's pre-warmed "healthy" cache.
      _setReacherHealthCacheForTests(null);
    });

    it("healthy path: probes once, treats a determinate probe verdict as healthy, and uses real reacher_smtp checks after", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        // A healthy Reacher completes the SMTP handshake for every address,
        // including the self-test probe mailbox -> "invalid" (doesn't exist).
        const verdict = body.to_email === mockEnv.REACHER_SELFTEST_EMAIL ? "invalid" : "safe";
        return jsonResponse({ is_reachable: verdict });
      });

      const result = await AddressVerificationService.checkAddress("person@example.com");

      expect(result).toEqual({ blocked: false, verdict: "safe", method: "reacher_smtp" });
      // One call for the self-test probe, one for the real address.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ to_email: mockEnv.REACHER_SELFTEST_EMAIL }),
        }),
      );
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("healthy path: a cached-healthy probe is not repeated on every call (no fetch spam)", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValue(jsonResponse({ is_reachable: "invalid" }));

      await AddressVerificationService.checkAddress("first@example.com");
      await AddressVerificationService.checkAddress("second@example.com");
      await AddressVerificationService.checkAddress("third@example.com");

      // 1 probe + 3 real checks, not 3 probes + 3 real checks.
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it("demoted path: a persistently-unknown probe (e.g. outbound TCP 25 blocked) auto-demotes to the lite fallback, not reacher_smtp", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse({ is_reachable: "unknown" }),
      );

      const result = await AddressVerificationService.checkAddress("person@example.com");

      // Demoted: the real, maintained syntax+MX+disposable fallback runs,
      // not a mislabeled "reacher_smtp" result built from an unknown verdict.
      expect(result).toEqual({ blocked: false, verdict: "safe", method: "lite_fallback" });
      expect(mockResolveMx).toHaveBeenCalledWith("example.com");
    });

    it("demoted path: a probe that errors/times out (same as a blocked SMTP port) also auto-demotes to the lite fallback", async () => {
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await AddressVerificationService.checkAddress("person@example.com");

      expect(result.method).toBe("lite_fallback");
    });

    it("demoted path: logs a clear warning identifying the Reacher self-test failure (never a silent downgrade)", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse({ is_reachable: "unknown" }),
      );

      await AddressVerificationService.checkAddress("person@example.com");

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reacherApiUrl: mockEnv.REACHER_API_URL }),
        expect.stringContaining("Reacher self-test failed"),
      );
    });

    it("demoted path: a known-bad address is still caught by the lite fallback's own checks while demoted", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse({ is_reachable: "unknown" }),
      );

      const result = await AddressVerificationService.checkAddress("a@mailinator.com");

      expect(result).toEqual({ blocked: false, verdict: "risky", method: "lite_fallback" });
    });

    it("demoted path: a persistently-unknown probe does not repeat the probe fetch on every call either", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValue(jsonResponse({ is_reachable: "unknown" }));

      await AddressVerificationService.checkAddress("first@example.com");
      await AddressVerificationService.checkAddress("second@example.com");

      // Only 1 probe call total; the demoted real checks use the lite
      // fallback (no fetch), so there should be exactly 1 fetch call overall.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("recovery: once a later probe succeeds, logs a recovery notice and resumes real reacher_smtp checks", async () => {
      const fetchSpy = vi.spyOn(global, "fetch");
      fetchSpy.mockResolvedValueOnce(jsonResponse({ is_reachable: "unknown" })); // probe 1: broken
      fetchSpy.mockResolvedValue(jsonResponse({ is_reachable: "invalid" })); // everything after: healthy

      const first = await AddressVerificationService.checkAddress("person@example.com");
      expect(first.method).toBe("lite_fallback");

      // Simulate the TTL window elapsing so the next call re-probes.
      _setReacherHealthCacheForTests({ healthy: false, checkedAt: Date.now() - 11 * 60 * 1000 });

      const second = await AddressVerificationService.checkAddress("nobody@example.com");

      expect(second).toEqual({ blocked: true, verdict: "invalid", method: "reacher_smtp" });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ reacherApiUrl: mockEnv.REACHER_API_URL }),
        expect.stringContaining("Reacher self-test recovered"),
      );
    });

    it("does not probe at all when Reacher isn't configured (lite fallback short-circuits first)", async () => {
      mockEnv.REACHER_API_URL = undefined;
      const fetchSpy = vi.spyOn(global, "fetch");

      const result = await AddressVerificationService.checkAddress("person@example.com");

      expect(result.method).toBe("lite_fallback");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
