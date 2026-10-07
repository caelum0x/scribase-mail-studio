import { describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import { UnsendApiError } from "../api-error";
import { SENDING_ONLY_MESSAGE } from "../permissions";
import { camelToSnake, snakeToCamel, toCamelKeys, toSnakeKeys } from "./case";
import {
  isValidAddress,
  parseResendScheduledAt,
  resendSendEmailSchema,
  toEmailContent,
} from "./email-schema";
import { toLastEvent } from "./email-presenter";
import { ResendApiError, toResendError } from "./errors";
import { paginate, parseCursorParams } from "./pagination";

describe("case conversion", () => {
  it("converts single keys both ways", () => {
    expect(snakeToCamel("reply_to")).toBe("replyTo");
    expect(snakeToCamel("x_batch_2")).toBe("xBatch2");
    expect(camelToSnake("scheduledAt")).toBe("scheduled_at");
    expect(camelToSnake("contentID")).toBe("content_id");
  });

  it("deep-converts while preserving free-form maps", () => {
    const input = {
      reply_to: "a@b.co",
      headers: { "X-Custom_Header": "1" },
      attachments: [{ content_type: "text/plain" }],
    };
    expect(toCamelKeys(input, ["headers"])).toEqual({
      replyTo: "a@b.co",
      headers: { "X-Custom_Header": "1" },
      attachments: [{ contentType: "text/plain" }],
    });
  });

  it("serializes dates to ISO when converting to snake_case", () => {
    const createdAt = new Date("2026-10-07T00:00:00.000Z");
    expect(toSnakeKeys({ createdAt, lastEvent: "sent" })).toEqual({
      created_at: "2026-10-07T00:00:00.000Z",
      last_event: "sent",
    });
  });
});

describe("Resend error mapping", () => {
  const map = (code: ConstructorParameters<typeof UnsendApiError>[0]["code"], message: string) =>
    toResendError(new UnsendApiError({ code, message })).toBody();

  it.each([
    ["BAD_REQUEST", "Domain is not verified", 422, "validation_error"],
    ["BAD_REQUEST", "Invalid Idempotency-Key length", 400, "invalid_idempotency_key"],
    ["UNAUTHORIZED", "No Authorization header provided", 401, "missing_api_key"],
    ["FORBIDDEN", SENDING_ONLY_MESSAGE, 401, "restricted_api_key"],
    ["FORBIDDEN", "Invalid API token", 403, "invalid_api_key"],
    ["FORBIDDEN", "API key does not have access to domain: x.com", 403, "validation_error"],
    ["NOT_FOUND", "Email not found", 404, "not_found"],
    ["NOT_UNIQUE", "Idempotency-Key already used with a different payload", 409, "invalid_idempotent_request"],
    ["NOT_UNIQUE", "Request with same Idempotency-Key is in progress. Retry later.", 409, "concurrent_idempotent_requests"],
    ["RATE_LIMITED", "Rate limit exceeded", 429, "rate_limit_exceeded"],
    ["RATE_LIMITED", "Daily sending limit reached", 429, "daily_quota_exceeded"],
    ["INTERNAL_SERVER_ERROR", "boom", 500, "application_error"],
  ] as const)("%s %s -> %i %s", (code, message, status, name) => {
    expect(map(code, message)).toMatchObject({ statusCode: status, name });
  });

  it("maps zod errors and hides unexpected errors", () => {
    const zodError = (() => {
      try {
        z.object({ a: z.string() }).strict().parse({ a: "x", b: 1 });
      } catch (e) {
        return e as ZodError;
      }
      throw new Error("unreachable");
    })();
    expect(toResendError(zodError).toBody()).toEqual({
      statusCode: 422,
      name: "validation_error",
      message: "Unsupported field(s): `b`.",
    });
    expect(toResendError(new Error("db password leaked")).toBody()).toMatchObject({
      statusCode: 500,
      name: "application_error",
    });
    expect(toResendError(new Error("x")).message).not.toContain("password");
  });
});

describe("cursor pagination", () => {
  it("validates params", () => {
    expect(parseCursorParams({})).toEqual({ limit: 20 });
    expect(parseCursorParams({ limit: "5", after: "a" })).toEqual({ limit: 5, after: "a" });
    expect(() => parseCursorParams({ limit: "0" })).toThrow(ResendApiError);
    expect(() => parseCursorParams({ limit: "101" })).toThrow(ResendApiError);
    expect(() => parseCursorParams({ limit: "abc" })).toThrow(ResendApiError);
    expect(() => parseCursorParams({ after: "a", before: "b" })).toThrow(/only use one/);
  });

  const rows = [5, 4, 3, 2, 1].map((n) => ({
    id: `id_${n}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
  }));

  it("builds an `after` keyset query, newest first, with has_more", async () => {
    const fetch = vi.fn(async ({ take }: { take: number }) => rows.slice(2, 2 + take));
    const result = await paginate(
      { limit: 2, after: "id_4" },
      { resolveCursor: async () => rows[1]!, fetch },
    );
    expect(result).toEqual({ object: "list", has_more: true, data: [rows[2], rows[3]] });
    expect(fetch).toHaveBeenCalledWith({
      cursor: {
        OR: [
          { createdAt: { lt: rows[1]!.createdAt } },
          { createdAt: rows[1]!.createdAt, id: { lt: "id_4" } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    });
  });

  it("builds a `before` query ascending and returns newest first", async () => {
    const fetch = vi.fn(async (_args: { take: number }) => [rows[1]!, rows[0]!]);
    const result = await paginate(
      { limit: 2, before: "id_3" },
      { resolveCursor: async () => rows[2]!, fetch },
    );
    expect(result).toEqual({ object: "list", has_more: false, data: [rows[0], rows[1]] });
    expect(fetch.mock.calls[0]![0]).toMatchObject({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("rejects unknown cursors", async () => {
    await expect(
      paginate({ limit: 2, after: "nope" }, { resolveCursor: async () => null, fetch: vi.fn() }),
    ).rejects.toMatchObject({ errorName: "validation_error" });
  });
});

describe("Resend send-email schema", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const resolve = vi.fn(async (id: string) => `tpl_${id}`);
  const base = { from: "Acme <a@acme.dev>", to: "u@example.com", subject: "Hi", text: "Hi" };

  it("validates addresses", () => {
    expect(isValidAddress("a@b.co")).toBe(true);
    expect(isValidAddress("Acme Inc <a@b.co>")).toBe(true);
    expect(isValidAddress("not-an-address")).toBe(false);
  });

  it("rejects unknown keys instead of stripping them", () => {
    expect(() => resendSendEmailSchema.parse({ ...base, replyTo: "x@y.co" })).toThrow(ZodError);
  });

  it("parses ISO and natural-language scheduled_at", () => {
    expect(parseResendScheduledAt("2026-10-08T09:00:00Z", now).toISOString()).toBe(
      "2026-10-08T09:00:00.000Z",
    );
    expect(parseResendScheduledAt("in 1 min", now).getTime()).toBe(now.getTime() + 60_000);
    expect(() => parseResendScheduledAt("2026-10-01T00:00:00Z", now)).toThrow(/future/);
    expect(() => parseResendScheduledAt("2026-12-01T00:00:00Z", now)).toThrow(/30 days/);
    expect(() => parseResendScheduledAt("whenever", now)).toThrow(/Invalid `scheduled_at`/);
  });

  it("maps snake_case input to EmailContent", async () => {
    const input = resendSendEmailSchema.parse({
      ...base,
      reply_to: ["r@acme.dev"],
      cc: "c@example.com",
      scheduled_at: "in 1 min",
      tags: [{ name: "k", value: "v" }],
      attachments: [{ filename: "a.txt", content: "aGk=" }],
      headers: { "X-A": "1" },
    });
    await expect(toEmailContent(input, resolve, now)).resolves.toEqual({
      from: "Acme <a@acme.dev>",
      to: ["u@example.com"],
      subject: "Hi",
      text: "Hi",
      replyTo: ["r@acme.dev"],
      cc: ["c@example.com"],
      headers: { "X-A": "1" },
      scheduledAt: "2026-10-07T12:01:00.000Z",
      attachments: [{ filename: "a.txt", content: "aGk=" }],
      tags: [{ name: "k", value: "v" }],
    });
  });

  it("accepts Buffer-serialized attachment content", async () => {
    const input = resendSendEmailSchema.parse({
      ...base,
      attachments: [{ filename: "a.txt", content: { type: "Buffer", data: [104, 105] } }],
    });
    const content = await toEmailContent(input, resolve, now);
    expect(content.attachments).toEqual([{ filename: "a.txt", content: "aGk=" }]);
  });

  it("maps template id/alias and stringifies variables", async () => {
    const input = resendSendEmailSchema.parse({
      from: base.from,
      to: base.to,
      template: { id: "welcome", variables: { name: "Ada", count: 3 } },
    });
    const content = await toEmailContent(input, resolve, now);
    expect(content).toMatchObject({
      templateId: "tpl_welcome",
      variables: { name: "Ada", count: "3" },
    });
  });

  it.each([
    [{ react: "<Email />" }, /react/],
    [{ topic_id: "t" }, /topic_id/],
    [{ to: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) }, /maximum of 50/],
    // path: http:// (not https) is rejected immediately — no DNS call needed.
    [{ attachments: [{ path: "http://example.com/file.pdf" }] }, /https/],
    [{ attachments: [{ filename: "a", content: "not base64!" }] }, /base64/],
    [{ template: { id: "t" } }, /cannot be combined/],
    [{ subject: undefined }, /subject/],
    [{ text: undefined }, /html/],
  ])("rejects %j", async (override, message) => {
    const input = resendSendEmailSchema.parse({ ...base, ...override });
    await expect(toEmailContent(input, resolve, now)).rejects.toThrow(message);
  });

  it("accepts content_id and content_type on attachments", async () => {
    const input = resendSendEmailSchema.parse({
      ...base,
      html: '<img src="cid:logo">',
      text: undefined,
      attachments: [{ filename: "logo.png", content: "aGk=", content_id: "logo", content_type: "image/png" }],
    });
    const content = await toEmailContent(input, resolve, now);
    expect(content.attachments).toEqual([
      { filename: "logo.png", content: "aGk=", cid: "logo", contentType: "image/png" },
    ]);
  });
});

describe("last_event mapping", () => {
  it("maps internal statuses to Resend events", () => {
    expect(toLastEvent("CANCELLED")).toBe("canceled");
    expect(toLastEvent("DELIVERY_DELAYED")).toBe("delivery_delayed");
    expect(toLastEvent("REJECTED")).toBe("failed");
    expect(toLastEvent("SCHEDULED")).toBe("scheduled");
  });
});
