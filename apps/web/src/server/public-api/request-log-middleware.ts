/**
 * Async request-log middleware for the Resend-compatible public API.
 *
 * Records every request into `ApiRequestLog` with:
 *   method, path, status, duration, api key id, user agent, IP,
 *   request/response bodies (truncated, secrets redacted).
 *
 * Design principles:
 * - Writes are fire-and-forget: the response is sent before the DB write.
 * - Failures are swallowed with a logger.error; they MUST NOT surface to the caller.
 * - Sensitive fields (Authorization, passwords, secrets) are always redacted.
 * - Body payloads are truncated to MAX_BODY_CHARS.
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "./hono";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";

const MAX_BODY_CHARS = 4_096;
const LOG_RETENTION_DAYS_DEFAULT = 30;

/** env override: API_LOG_RETENTION_DAYS */
export function getLogRetentionDays(): number {
  // Using globalThis so the call is valid in both Node and Edge environments.
  const env = (globalThis as Record<string, unknown>)["process"];
  const raw =
    env !== null && typeof env === "object" && "env" in (env as object)
      ? (env as { env: Record<string, string | undefined> }).env[
          "API_LOG_RETENTION_DAYS"
        ]
      : undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : LOG_RETENTION_DAYS_DEFAULT;
}

const SENSITIVE_KEYS = new Set([
  "authorization",
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "signing_secret",
  "whsec",
]);

function redactBody(obj: unknown, depth = 0): unknown {
  if (depth > 5) return obj;
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactBody(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lkey = key.toLowerCase();
    if (
      SENSITIVE_KEYS.has(lkey) ||
      lkey.includes("secret") ||
      lkey.includes("token")
    ) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactBody(value, depth + 1);
    }
  }
  return result;
}

function truncateJson(obj: unknown): unknown {
  const str = JSON.stringify(obj);
  if (str.length <= MAX_BODY_CHARS) return obj;
  return { _truncated: true, _preview: str.slice(0, MAX_BODY_CHARS) };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
  }
}

/**
 * Reads and clones the request body for logging. Returns `null` if the body
 * is absent or not text-like. The original body stream is not consumed
 * because we call `c.req.text()` which Hono buffers.
 */
async function captureRequestBody(c: Context): Promise<unknown> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("application/json") && !ct.includes("text/")) {
    return null;
  }
  try {
    const text = await c.req.text();
    return truncateJson(redactBody(safeParse(text)));
  } catch {
    return null;
  }
}

function captureResponseBody(text: string): unknown {
  if (!text) return null;
  return truncateJson(redactBody(safeParse(text)));
}

function getClientIp(c: Context): string | null {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    null
  );
}

/**
 * Middleware: wraps the handler, captures the response, then asynchronously
 * writes an `ApiRequestLog` row. Never delays or throws to the caller.
 */
export async function requestLogMiddleware(
  c: Context<AppEnv>,
  next: Next,
): Promise<void> {
  const start = Date.now();
  let requestBody: unknown = null;

  // Attempt to capture request body before the handler consumes it.
  try {
    requestBody = await captureRequestBody(c);
  } catch {
    // ignore
  }

  // Run the handler, collecting the full response text for the log.
  let responseText = "";
  await next();

  try {
    responseText = await c.res.clone().text();
  } catch {
    // ignore
  }

  const durationMs = Date.now() - start;
  const status = c.res.status;
  const team = c.var.team;
  const teamId = team?.id;

  if (!teamId) {
    // Auth failed before we could identify the team — skip logging.
    return;
  }

  const responseBody = captureResponseBody(responseText);

  // Fire-and-forget: the write happens after the response is already sent.
  // `queueMicrotask` is available in both Node and Edge runtimes.
  // Promise.resolve().then(...) turns synchronous throws into rejections, so
  // a logging failure can never surface as an uncaught exception.
  queueMicrotask(() => {
    void Promise.resolve()
      .then(() =>
        db.apiRequestLog.create({
          data: {
            teamId,
            apiKeyId: team.apiKeyId ?? null,
            method: c.req.method,
            path: new URL(c.req.url).pathname,
            statusCode: status,
            durationMs,
            userAgent: c.req.header("user-agent") ?? null,
            ipAddress: getClientIp(c),
            requestBody: requestBody ?? undefined,
            responseBody: responseBody ?? undefined,
            errorName: extractErrorName(responseBody),
          },
        }),
      )
      .catch((err: unknown) => {
        logger.error(
          { err },
          "[requestLogMiddleware] failed to write ApiRequestLog",
        );
      });
  });
}

function extractErrorName(responseBody: unknown): string | null {
  if (
    responseBody !== null &&
    typeof responseBody === "object" &&
    "name" in (responseBody as Record<string, unknown>)
  ) {
    const name = (responseBody as Record<string, unknown>).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}
