import { Hono, type Context, type Next } from "hono";
import { isSelfHosted } from "~/utils/common";
import { logger } from "~/server/logger/log";
import { getTeamFromToken } from "../auth";
import { UnsendApiError } from "../api-error";
import type { AppEnv } from "../hono";
import {
  checkApiKeyAccess,
  DOMAIN_RESTRICTED_MESSAGE,
  SENDING_ONLY_MESSAGE,
} from "../permissions";
import { enforceTeamRateLimit } from "../rate-limit";
import { handleResendError, ResendApiError } from "./errors";

/**
 * Resend-compatible API.
 *
 * Served at `/api/resend/*` and, in production, as the root of its own host
 * (`https://api.mail.scribase.com/*`, Caddy rewrites to `/api/resend/*`).
 * The official Resend SDKs work by changing only the base URL:
 *
 *   new Resend(key, { baseUrl: "https://api.mail.scribase.com" })
 *   new Resend(key, { baseUrl: "https://mail.scribase.com/api/resend" })
 *
 * Auth, API key permission policy and the per-team rate limit are shared with
 * the native `/api/v1` API; only the wire format differs.
 */
export const RESEND_BASE_PATH = "/api/resend";

export type ResendApp = Hono<AppEnv, Record<string, never>, typeof RESEND_BASE_PATH>;

const MISSING_KEY_MESSAGE =
  "Missing API key in the authorization header. Include the following header Authorization: Bearer YOUR_API_KEY in the request.";

async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const header = c.req.header("Authorization");
  if (!header || !header.trim()) {
    throw new ResendApiError("missing_api_key", MISSING_KEY_MESSAGE);
  }

  try {
    c.set("team", await getTeamFromToken(c));
  } catch (error) {
    if (error instanceof UnsendApiError) {
      if (error.code === "UNAUTHORIZED") {
        throw new ResendApiError("missing_api_key", MISSING_KEY_MESSAGE);
      }
      throw new ResendApiError("invalid_api_key", "API key is invalid");
    }
    logger.error({ err: error }, "Resend compat auth failed");
    throw new ResendApiError("application_error", "Authentication failed");
  }
  await next();
}

async function permissionMiddleware(c: Context<AppEnv>, next: Next) {
  const team = c.var.team;
  const decision = checkApiKeyAccess(
    { permission: team.apiKey?.permission, domainId: team.apiKey?.domainId },
    c.req.method,
    c.req.path,
  );
  if (!decision.allowed) {
    if (decision.reason === "SENDING_ONLY") {
      throw new ResendApiError("restricted_api_key", SENDING_ONLY_MESSAGE);
    }
    throw new ResendApiError("validation_error", DOMAIN_RESTRICTED_MESSAGE, 403);
  }
  await next();
}

async function rateLimitMiddleware(c: Context<AppEnv>, next: Next) {
  if (!isSelfHosted()) {
    await enforceTeamRateLimit(c, c.var.team);
  }
  await next();
}

export function getResendApp(): ResendApp {
  const app = new Hono<AppEnv>().basePath(RESEND_BASE_PATH) as ResendApp;

  app.onError(handleResendError);
  app.notFound((c) =>
    c.json(
      new ResendApiError(
        "not_found",
        "The requested endpoint could not be found.",
      ).toBody(),
      404,
    ),
  );

  app.use("*", authMiddleware);
  app.use("*", permissionMiddleware);
  app.use("*", rateLimitMiddleware);

  return app;
}

/** Parse a JSON body, mapping malformed JSON to a Resend validation_error. */
export async function readJsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (!raw.trim()) {
    throw new ResendApiError("validation_error", "Request body is required.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ResendApiError(
      "validation_error",
      "Request body must be valid JSON.",
    );
  }
}
