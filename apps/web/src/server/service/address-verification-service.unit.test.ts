import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, mockLogger } = vi.hoisted(() => ({
  mockEnv: {
    REACHER_ENABLED: true,
    REACHER_API_URL: "http://reacher.internal:8080" as string | undefined,
    REACHER_API_KEY: undefined as string | undefined,
    REACHER_TIMEOUT_MS: 4000,
    REACHER_BLOCK_VERDICTS: "invalid",
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("~/env", () => ({ env: mockEnv }));
vi.mock("~/server/logger/log", () => ({ logger: mockLogger }));

import { AddressVerificationService } from "./address-verification-service";

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

    expect(result).toEqual({ blocked: true, verdict: "invalid" });
  });

  it("does not block safe, risky, or unknown verdicts by default", async () => {
    for (const verdict of ["safe", "risky", "unknown"]) {
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse({ is_reachable: verdict }),
      );
      const result = await AddressVerificationService.checkAddress(
        "person@example.com",
      );
      expect(result).toEqual({ blocked: false, verdict });
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

    expect(result).toEqual({ blocked: false, verdict: "unknown" });
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

    expect(result).toEqual({ blocked: false, verdict: "unknown" });
  });

  it("fails open when the backend returns a non-2xx response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({}, false, 500),
    );

    const result = await AddressVerificationService.checkAddress(
      "person@example.com",
    );

    expect(result).toEqual({ blocked: false, verdict: "unknown" });
  });

  it("is a no-op (never blocks, never calls fetch) when disabled", async () => {
    mockEnv.REACHER_ENABLED = false;
    const fetchSpy = vi.spyOn(global, "fetch");

    const result = await AddressVerificationService.checkAddress(
      "person@example.com",
    );

    expect(result).toEqual({ blocked: false, verdict: "unverified" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when no backend URL is configured", async () => {
    mockEnv.REACHER_API_URL = undefined;
    const fetchSpy = vi.spyOn(global, "fetch");

    const result = await AddressVerificationService.checkAddress(
      "person@example.com",
    );

    expect(result).toEqual({ blocked: false, verdict: "unverified" });
    expect(fetchSpy).not.toHaveBeenCalled();
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
    });
    expect(results["bad@example.com"]).toEqual({
      blocked: true,
      verdict: "invalid",
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

    expect(result).toEqual({ blocked: true, verdict: "risky" });
  });

  it("returns an empty result for an empty address list without calling fetch", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");

    const results = await AddressVerificationService.checkAddresses([]);

    expect(results).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
