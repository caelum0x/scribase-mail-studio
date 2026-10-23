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
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

      const userIds = Array.from(
        new Set(
          page
            .map((r) => r.actorUserId)
            .filter((id): id is number => id !== null),
        ),
      );
      const apiKeyIds = Array.from(
        new Set(
          page
            .map((r) => r.actorApiKeyId)
            .filter((id): id is number => id !== null),
        ),
      );

      const [users, apiKeys] = await Promise.all([
        userIds.length > 0
          ? db.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, name: true, email: true },
            })
          : Promise.resolve([]),
        apiKeyIds.length > 0
          ? db.apiKey.findMany({
              where: { id: { in: apiKeyIds } },
              select: { id: true, name: true },
            })
          : Promise.resolve([]),
      ]);

      const userMap = new Map(users.map((u) => [u.id, u]));
      const apiKeyMap = new Map(apiKeys.map((k) => [k.id, k]));

      const data = page.map((row) => {
        const actorUser = row.actorUserId
          ? userMap.get(row.actorUserId)
          : undefined;
        const actorApiKey = row.actorApiKeyId
          ? apiKeyMap.get(row.actorApiKeyId)
          : undefined;
        const actorName =
          row.actorType === "USER"
            ? actorUser?.name || actorUser?.email || "Unknown user"
            : row.actorType === "API_KEY"
              ? actorApiKey?.name
                ? `API key: ${actorApiKey.name}`
                : "API key"
              : "System";
        return { ...row, actorName };
      });

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
