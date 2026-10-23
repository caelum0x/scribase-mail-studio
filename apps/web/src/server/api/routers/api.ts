import { z } from "zod";
import { ApiPermission } from "@prisma/client";

import {
  apiKeyProcedure,
  createTRPCRouter,
  teamProcedure,
} from "~/server/api/trpc";
import {
  addApiKey,
  deleteApiKey,
  updateApiKey,
} from "~/server/service/api-service";
import { recordAudit, userAuditCtx, AuditAction } from "~/server/service/audit-service";

export const apiRouter = createTRPCRouter({
  createToken: teamProcedure
    .input(
      z.object({
        name: z.string(),
        permission: z.nativeEnum(ApiPermission),
        domainId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await addApiKey({
        name: input.name,
        permission: input.permission,
        teamId: ctx.team.id,
        domainId: input.domainId,
      });
      await recordAudit(
        userAuditCtx(ctx.team.id, ctx.session.user.id),
        AuditAction.API_KEY_CREATED,
        { targetType: "api_key", metadata: { name: input.name, permission: input.permission } },
      );
      return result;
    }),

  getApiKeys: teamProcedure.query(async ({ ctx }) => {
    const keys = await ctx.db.apiKey.findMany({
      where: {
        teamId: ctx.team.id,
      },
      select: {
        id: true,
        name: true,
        permission: true,
        partialToken: true,
        lastUsed: true,
        createdAt: true,
        domainId: true,
        domain: {
          select: {
            name: true,
          },
        },
        },
      orderBy: {
        createdAt: "desc",
      },
    });

    return keys;
  }),

  updateApiKey: apiKeyProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
        domainId: z.number().int().positive().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await updateApiKey({
        id: input.id,
        teamId: ctx.team.id,
        name: input.name,
        domainId: input.domainId,
      });
      await recordAudit(
        userAuditCtx(ctx.team.id, ctx.session.user.id),
        AuditAction.API_KEY_UPDATED,
        { targetType: "api_key", targetId: input.id },
      );
      return result;
    }),

  deleteApiKey: apiKeyProcedure.mutation(async ({ ctx, input }) => {
    await recordAudit(
      userAuditCtx(ctx.team.id, ctx.session.user.id),
      AuditAction.API_KEY_DELETED,
      { targetType: "api_key", targetId: input.id },
    );
    return deleteApiKey(input.id);
  }),

  /**
   * Cursor-paginated list of public API request logs for the current team.
   * Backs the Dev Settings > API Logs dashboard page so a user can
   * self-diagnose whether their Resend-compatible SDK calls actually
   * reached the server, instead of guessing from a silent failure.
   */
  getRequestLogs: teamProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        /** "all" | "success" (status < 400) | "error" (status >= 400) */
        outcome: z.enum(["all", "success", "error"]).default("all"),
        method: z.string().optional(),
        apiKeyId: z.number().int().optional(),
        /** Case-insensitive substring match against the request path. */
        pathSearch: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        teamId: ctx.team.id,
        ...(input.outcome === "success"
          ? { statusCode: { lt: 400 } }
          : input.outcome === "error"
            ? { statusCode: { gte: 400 } }
            : {}),
        ...(input.method ? { method: input.method } : {}),
        ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
        ...(input.pathSearch
          ? { path: { contains: input.pathSearch, mode: "insensitive" as const } }
          : {}),
        ...(input.cursor ? { id: { lt: input.cursor } } : {}),
      };

      const rows = await ctx.db.apiRequestLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        select: {
          id: true,
          method: true,
          path: true,
          statusCode: true,
          durationMs: true,
          apiKeyId: true,
          userAgent: true,
          ipAddress: true,
          errorName: true,
          createdAt: true,
        },
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

      const apiKeyIds = Array.from(
        new Set(
          page.map((r) => r.apiKeyId).filter((id): id is number => id !== null),
        ),
      );
      const apiKeys = apiKeyIds.length
        ? await ctx.db.apiKey.findMany({
            where: { id: { in: apiKeyIds } },
            select: { id: true, name: true },
          })
        : [];
      const apiKeyMap = new Map(apiKeys.map((k) => [k.id, k.name]));

      const data = page.map((row) => ({
        ...row,
        apiKeyName: row.apiKeyId ? apiKeyMap.get(row.apiKeyId) ?? "Deleted key" : null,
      }));

      return { data, nextCursor, hasMore };
    }),

  /** Full detail (incl. redacted request/response bodies) for one log row. */
  getRequestLog: teamProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const log = await ctx.db.apiRequestLog.findFirst({
        where: { id: input.id, teamId: ctx.team.id },
      });

      if (!log) {
        return null;
      }

      const apiKey = log.apiKeyId
        ? await ctx.db.apiKey.findUnique({
            where: { id: log.apiKeyId },
            select: { name: true },
          })
        : null;

      return { ...log, apiKeyName: apiKey?.name ?? null };
    }),
});
