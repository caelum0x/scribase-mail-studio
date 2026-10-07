import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock `mailauth` to avoid real DNS lookups in unit tests.
vi.mock("mailauth", () => ({
  authenticate: vi.fn(),
}));

import { authenticate } from "mailauth";
import { checkAuth } from "./auth-check";

const mockAuthenticate = vi.mocked(authenticate);

const SAMPLE_RAW = Buffer.from(
  [
    "From: sender@example.com",
    "To: inbox@acme.com",
    "Subject: Test",
    "",
    "Hello",
  ].join("\r\n"),
);

describe("checkAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns pass results when authentication succeeds", async () => {
    mockAuthenticate.mockResolvedValueOnce({
      spf: { status: { result: "pass" } },
      dkim: { results: [{ status: { result: "pass" } }] },
      dmarc: { status: { result: "pass" }, policy: "none" },
    } as ReturnType<typeof authenticate> extends Promise<infer R> ? R : never);

    const result = await checkAuth(SAMPLE_RAW, "1.2.3.4", "sender@example.com", "mail.example.com");

    expect(result.spf).toBe("pass");
    expect(result.dkim).toBe("pass");
    expect(result.dmarc).toBe("pass");
    expect(result.dmarcReject).toBe(false);
  });

  it("sets dmarcReject=true when policy is reject and dmarc is fail", async () => {
    mockAuthenticate.mockResolvedValueOnce({
      spf: { status: { result: "fail" } },
      dkim: { results: [{ status: { result: "fail" } }] },
      dmarc: { status: { result: "fail" }, policy: "reject" },
    } as ReturnType<typeof authenticate> extends Promise<infer R> ? R : never);

    const result = await checkAuth(SAMPLE_RAW, "5.6.7.8", "spammer@evil.com", "evil.com");

    expect(result.spf).toBe("fail");
    expect(result.dmarcReject).toBe(true);
  });

  it("does not reject when DMARC policy is quarantine", async () => {
    mockAuthenticate.mockResolvedValueOnce({
      spf: { status: { result: "fail" } },
      dkim: { results: [] },
      dmarc: { status: { result: "fail" }, policy: "quarantine" },
    } as ReturnType<typeof authenticate> extends Promise<infer R> ? R : never);

    const result = await checkAuth(SAMPLE_RAW, "5.6.7.8", "spammer@evil.com", "evil.com");

    expect(result.dmarcReject).toBe(false);
  });

  it("returns null fields when auth data is missing", async () => {
    mockAuthenticate.mockResolvedValueOnce({} as ReturnType<typeof authenticate> extends Promise<infer R> ? R : never);

    const result = await checkAuth(SAMPLE_RAW, "1.2.3.4", "", "");

    expect(result.spf).toBeNull();
    expect(result.dkim).toBeNull();
    expect(result.dmarc).toBeNull();
    expect(result.dmarcReject).toBe(false);
  });
});
