import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodIssue } from "zod";
import { logger } from "~/server/logger/log";
import { UnsendApiError } from "../api-error";
import { SENDING_ONLY_MESSAGE } from "../permissions";

/**
 * Resend error names (https://resend.com/docs/api-reference/errors) and the
 * HTTP status Resend pairs them with.
 */
export const RESEND_ERRORS = {
  invalid_idempotency_key: 400,
  validation_error: 422,
  missing_api_key: 401,
  restricted_api_key: 401,
  invalid_api_key: 403,
  not_found: 404,
  method_not_allowed: 405,
  invalid_idempotent_request: 409,
  concurrent_idempotent_requests: 409,
  invalid_attachment: 422,
  invalid_from_address: 422,
  invalid_access: 422,
  invalid_parameter: 422,
  invalid_region: 422,
  missing_required_field: 422,
  rate_limit_exceeded: 429,
  daily_quota_exceeded: 429,
  monthly_quota_exceeded: 429,
  security_error: 451,
  application_error: 500,
  internal_server_error: 500,
} as const satisfies Record<string, ContentfulStatusCode>;

export type ResendErrorName = keyof typeof RESEND_ERRORS;

export type ResendErrorBody = {
  statusCode: number;
  name: ResendErrorName;
  message: string;
};

export class ResendApiError extends Error {
  readonly errorName: ResendErrorName;
  readonly statusCode: ContentfulStatusCode;

  constructor(
    name: ResendErrorName,
    message: string,
    statusCode?: ContentfulStatusCode,
  ) {
    super(message);
    this.name = "ResendApiError";
    this.errorName = name;
    this.statusCode = statusCode ?? RESEND_ERRORS[name];
  }

  toBody(): ResendErrorBody {
    return {
      statusCode: this.statusCode,
      name: this.errorName,
      message: this.message,
    };
  }
}

function fromUnsendError(err: UnsendApiError): ResendApiError {
  const message = err.message;
  switch (err.code) {
    case "BAD_REQUEST":
      if (/idempotency-key/i.test(message)) {
        return new ResendApiError("invalid_idempotency_key", message);
      }
      return new ResendApiError("validation_error", message);
    case "UNAUTHORIZED":
      return new ResendApiError("missing_api_key", message);
    case "FORBIDDEN":
      if (message === SENDING_ONLY_MESSAGE) {
        return new ResendApiError("restricted_api_key", message);
      }
      if (/invalid api (token|key)/i.test(message)) {
        return new ResendApiError("invalid_api_key", "API key is invalid");
      }
      // Resend answers 403 validation_error for domain/ownership problems.
      return new ResendApiError("validation_error", message, 403);
    case "NOT_FOUND":
      return new ResendApiError("not_found", message);
    case "METHOD_NOT_ALLOWED":
      return new ResendApiError("method_not_allowed", message);
    case "NOT_UNIQUE":
      if (/in progress/i.test(message)) {
        return new ResendApiError("concurrent_idempotent_requests", message);
      }
      return new ResendApiError("invalid_idempotent_request", message);
    case "RATE_LIMITED":
      if (/daily/i.test(message)) {
        return new ResendApiError("daily_quota_exceeded", message);
      }
      if (/monthly/i.test(message)) {
        return new ResendApiError("monthly_quota_exceeded", message);
      }
      return new ResendApiError("rate_limit_exceeded", message);
    case "INTERNAL_SERVER_ERROR":
    default:
      return new ResendApiError("application_error", message);
  }
}

function isMissingValueIssue(issue: ZodIssue): boolean {
  if (issue.code === "invalid_type") {
    return issue.received === "undefined" || issue.received === "null";
  }
  // Union fields (e.g. `to: string | string[]`) report one issue per branch.
  if (issue.code === "invalid_union") {
    return issue.unionErrors.every((unionError) =>
      unionError.issues.every(isMissingValueIssue),
    );
  }
  return false;
}

/** "Missing `to` field." style message for the first zod issue. */
export function fromZodError(err: ZodError): ResendApiError {
  const issue = err.issues[0];
  if (!issue) {
    return new ResendApiError("validation_error", "Invalid request body");
  }
  const field = issue.path.join(".");

  if (isMissingValueIssue(issue) && field) {
    return new ResendApiError("missing_required_field", `Missing \`${field}\` field.`);
  }
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((k) => `\`${field ? `${field}.` : ""}${k}\``);
    return new ResendApiError(
      "validation_error",
      `Unsupported field(s): ${keys.join(", ")}.`,
    );
  }
  return new ResendApiError(
    "validation_error",
    field ? `Invalid \`${field}\`: ${issue.message}` : issue.message,
  );
}

export function toResendError(err: unknown): ResendApiError {
  if (err instanceof ResendApiError) return err;
  if (err instanceof UnsendApiError) return fromUnsendError(err);
  if (err instanceof ZodError) return fromZodError(err);
  if (err instanceof HTTPException) {
    if (err.status === 404) return new ResendApiError("not_found", err.message);
    if (err.status === 405) {
      return new ResendApiError("method_not_allowed", err.message);
    }
    if (err.status >= 400 && err.status < 500) {
      return new ResendApiError(
        "validation_error",
        err.message,
        err.status as ContentfulStatusCode,
      );
    }
  }
  return new ResendApiError(
    "application_error",
    "Internal server error. We are unable to process your request right now, please try again later.",
  );
}

export function handleResendError(err: Error, c: Context): Response {
  const resendError = toResendError(err);
  if (resendError.statusCode >= 500) {
    logger.error(
      { err, path: c.req.path, method: c.req.method },
      "Resend compat API error",
    );
  }
  return c.json(resendError.toBody(), resendError.statusCode);
}
