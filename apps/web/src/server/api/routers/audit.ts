/**
 * Audit log router – list and filter the team's audit trail.
 */
import { z } from "zod";
import { createTRPCRouter, teamAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { AUDIT_LOG_RETENTION_DAYS } from "~/server/service/audit-service";

const PAGE_SIZE = 50;

export const auditRouter = createTRPCRouter({
  /** Paginated audit log for the current team. Admins only. */
  list: teamAdminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(PAGE_SIZE),
        /** Filter by action prefix, e.g. "api_key" matches api_key.created, api_key.deleted */
        actionPrefix: z.string().optional(),
        /** Filter by target type, e.g. "domain" */
        targetType: z.string().optional(),
        actorUserId: z.number().int().optional(),
        after: z.string().datetime().optional(),
        before: z.string().datetime().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        teamId: ctx.team.id,
        ...(input.actionPrefix
          ? { action: { startsWith: input.actionPrefix } }
          : {}),
        ...(input.targetType ? { targetType: input.targetType } : {}),
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
        ...(input.after || input.before
          ? {
              createdAt: {
                ...(input.after ? { gte: new Date(input.after) } : {}),
                ...(input.before ? { lte: new Date(input.before) } : {}),
              },
            }
          : {}),
        ...(input.cursor ? { id: { lt: input.cursor } } : {}),
      };

      const rows = await db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        select: {
          id: true,
          actorType: true,
          actorUserId: true,
          actorApiKeyId: true,
          action: true,
          targetType: true,
          targetId: true,
          metadata: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
        },
      });

      const hasMore = rows.length > input.limit;
      const data = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? data[data.length - 1]?.id : undefined;

      return { data, nextCursor, hasMore, retentionDays: AUDIT_LOG_RETENTION_DAYS };
    }),

  /** Return distinct action types in use for this team (for filter UI). */
  listActionTypes: teamAdminProcedure.query(async ({ ctx }) => {
    const rows = await db.auditLog.findMany({
      where: { teamId: ctx.team.id },
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
    });
    return rows.map((r: { action: string }) => r.action);
  }),
});
