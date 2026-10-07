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
});
