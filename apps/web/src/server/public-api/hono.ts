import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { Context, Next } from "hono";
import { handleError } from "./api-error";
import { env } from "~/env";
import { getTeamFromToken } from "~/server/public-api/auth";
import { isSelfHosted } from "~/utils/common";
import { UnsendApiError } from "./api-error";
import { Team, ApiPermission } from "@prisma/client";
import { logger } from "../logger/log";
import {
  checkApiKeyAccess,
  DOMAIN_RESTRICTED_MESSAGE,
  SENDING_ONLY_MESSAGE,
} from "./permissions";
import { enforceTeamRateLimit } from "./rate-limit";

export { DEFAULT_API_RATE_LIMIT } from "./rate-limit";

// Define AppEnv for Hono context
export type AppEnv = {
  Variables: {
    team: Team & {
      apiKeyId: number;
      apiKey: { domainId: number | null; permission: ApiPermission };
    };
  };
};

export function getApp() {
  const app = new OpenAPIHono<AppEnv>().basePath("/api");

  app.onError(handleError);

  // Auth and Team Middleware (runs before rate limiter)
  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    if (
      c.req.path.startsWith("/api/v1/doc") ||
      c.req.path.startsWith("/api/v1/ui") ||
      c.req.path === "/api/health"
    ) {
      return next();
    }

    try {
      const team = await getTeamFromToken(c as any);
      c.set("team", team);
    } catch (error) {
      if (error instanceof UnsendApiError) {
        throw error;
      }
      logger.error({ err: error }, "Error in getTeamFromToken middleware");
      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Authentication failed",
      });
    }
    await next();
  });

  // API key permission + domain-restriction enforcement
  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    const team = c.var.team;
    if (!team) {
      return next();
    }

    const decision = checkApiKeyAccess(
      {
        permission: team.apiKey?.permission,
        domainId: team.apiKey?.domainId,
      },
      c.req.method,
      c.req.path,
    );

    if (!decision.allowed) {
      throw new UnsendApiError({
        code: "FORBIDDEN",
        message:
          decision.reason === "SENDING_ONLY"
            ? SENDING_ONLY_MESSAGE
            : DOMAIN_RESTRICTED_MESSAGE,
      });
    }

    await next();
  });

  // Per-team rate limiter (shared with the Resend-compatible API)
  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    if (
      isSelfHosted() ||
      !c.var.team ||
      c.req.path.startsWith("/api/v1/doc") ||
      c.req.path.startsWith("/api/v1/ui") ||
      c.req.path === "/api/health"
    ) {
      return next();
    }

    await enforceTeamRateLimit(c, c.var.team);
    await next();
  });

  // The OpenAPI documentation will be available at /doc
  app.doc("/v1/doc", (c) => ({
    openapi: "3.0.0",
    info: {
      version: "1.0.0",
      title: "Scribase Mail API",
    },
    servers: [{ url: `${env.NEXTAUTH_URL}/api` }],
  }));

  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
    type: "http",
    scheme: "bearer",
  });

  app.get("/v1/ui", swaggerUI({ url: "/api/v1/doc" }));

  return app;
}

export type PublicAPIApp = OpenAPIHono<AppEnv>;
