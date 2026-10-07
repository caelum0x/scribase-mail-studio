/**
 * MCP server tool tests with a mocked fetch.
 * Uses vitest; run with: pnpm --filter @scribase-mail/mcp-server test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScribaseMailClient } from "./client.js";

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ─── Client tests ─────────────────────────────────────────────────────────────

describe("ScribaseMailClient", () => {
  const client = new ScribaseMailClient("test_key", "https://mail-api.scribase.com");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a POST /emails request with the correct shape", async () => {
    mockFetch.mockReturnValue(mockResponse({ id: "email_abc123" }));

    const result = await client.post<{ id: string }>("/emails", {
      from: "noreply@example.com",
      to: "user@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ id: "email_abc123" });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mail-api.scribase.com/emails");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer test_key");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("returns an error object on non-2xx response", async () => {
    mockFetch.mockReturnValue(
      mockResponse(
        { statusCode: 422, name: "validation_error", message: "Missing subject" },
        422,
      ),
    );

    const result = await client.post<{ id: string }>("/emails", {});
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
      message: "Missing subject",
    });
  });

  it("GET /emails/:id constructs the correct URL", async () => {
    mockFetch.mockReturnValue(mockResponse({ object: "email", id: "abc" }));

    await client.get<{ id: string }>("/emails/abc");

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://mail-api.scribase.com/emails/abc");
  });

  it("PATCH /emails/:id sends updated scheduled_at", async () => {
    mockFetch.mockReturnValue(mockResponse({ object: "email", id: "abc" }));

    await client.patch<{ id: string }>("/emails/abc", {
      scheduled_at: "in 1 hour",
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mail-api.scribase.com/emails/abc");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ scheduled_at: "in 1 hour" });
  });

  it("POST /emails/:id/cancel hits the correct path", async () => {
    mockFetch.mockReturnValue(mockResponse({ object: "email", id: "abc" }));

    await client.post<{ id: string }>("/emails/abc/cancel", {});

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://mail-api.scribase.com/emails/abc/cancel");
  });

  it("GET /domains lists domains", async () => {
    mockFetch.mockReturnValue(mockResponse({ object: "list", data: [] }));

    await client.get("/domains");

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://mail-api.scribase.com/domains");
  });

  it("POST /domains/:id/verify triggers verification", async () => {
    mockFetch.mockReturnValue(
      mockResponse({ object: "domain", id: "dom_123", status: "pending" }),
    );

    await client.post("/domains/dom_123/verify", {});

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://mail-api.scribase.com/domains/dom_123/verify");
  });

  it("handles malformed JSON in response", async () => {
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }),
    );

    const result = await client.get("/emails/bad");
    expect(result.data).toBeNull();
    expect(result.error?.name).toBe("parse_error");
  });

  it("POST /emails/batch sends array payload", async () => {
    mockFetch.mockReturnValue(
      mockResponse({ data: [{ id: "e1" }, { id: "e2" }] }),
    );

    await client.post("/emails/batch", [
      { from: "a@a.com", to: "b@b.com", subject: "s1", text: "t1" },
      { from: "a@a.com", to: "c@c.com", subject: "s2", text: "t2" },
    ]);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mail-api.scribase.com/emails/batch");
    expect(Array.isArray(JSON.parse(init.body as string))).toBe(true);
  });
});

// ─── resolveApiKey tests ──────────────────────────────────────────────────────

describe("resolveApiKey", async () => {
  const { resolveApiKey } = await import("./client.js");

  it("throws when no key is available", () => {
    const saved = process.env["SCRIBASE_MAIL_API_KEY"];
    const savedResend = process.env["RESEND_API_KEY"];
    delete process.env["SCRIBASE_MAIL_API_KEY"];
    delete process.env["RESEND_API_KEY"];
    expect(() => resolveApiKey()).toThrow(/API key/);
    process.env["SCRIBASE_MAIL_API_KEY"] = saved;
    process.env["RESEND_API_KEY"] = savedResend;
  });

  it("returns the passed key directly", () => {
    expect(resolveApiKey("hardcoded_key")).toBe("hardcoded_key");
  });
});
