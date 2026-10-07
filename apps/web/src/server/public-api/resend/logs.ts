/**
 * Resend-compatible API request logs.
 *
 * GET /logs           — list (cursor-paginated, newest first)
 * GET /logs/:id       — get one
 *
 * Shape matches Resend's `Log` interface:
 *   { id, created_at, endpoint, method, response_status,
 *     user_agent, request_body, response_body }
 */
import { db } from "~/server/db";
import type { ResendApp } from "./app";
import { ResendApiError } from "./errors";
import { mapList, paginate, parseCursorParams } from "./pagination";
import type { ApiRequestLog } from "@prisma/client";

function formatLog(log: ApiRequestLog) {
  return {
    object: "log",
    id: log.id,
    created_at: log.createdAt.toISOString(),
    endpoint: log.path,
    method: log.method,
    response_status: log.statusCode,
    duration_ms: log.durationMs,
    user_agent: log.userAgent ?? null,
    ip_address: log.ipAddress ?? null,
    error_name: log.errorName ?? null,
    request_body: log.requestBody ?? null,
    response_body: log.responseBody ?? null,
  };
}

export function registerLogRoutes(app: ResendApp): void {
  // GET /logs — cursor-paginated list
  app.get("/logs", async (c) => {
    const team = c.var.team;
    const params = parseCursorParams(c.req.query());

    const list = await paginate(params, {
      resolveCursor: (id) =>
        db.apiRequestLog.findFirst({
          where: { teamId: team.id, id },
          select: { id: true, createdAt: true },
        }),
      fetch: ({ cursor, orderBy, take }) =>
        db.apiRequestLog.findMany({
          where: cursor
            ? { AND: [{ teamId: team.id }, cursor] }
            : { teamId: team.id },
          orderBy,
          take,
        }),
    });

    return c.json(mapList(list, formatLog), 200);
  });

  // GET /logs/:id — get one
  app.get("/logs/:id", async (c) => {
    const team = c.var.team;
    const log = await db.apiRequestLog.findFirst({
      where: { id: c.req.param("id"), teamId: team.id },
    });

    if (!log) {
      throw new ResendApiError("not_found", "Log not found");
    }

    return c.json(formatLog(log), 200);
  });
}
