import { z } from "zod";

import {
  createTRPCRouter,
  protectedProcedure,
  teamProcedure,
  teamAdminProcedure,
} from "~/server/api/trpc";
import { TeamService } from "~/server/service/team-service";
import { db } from "~/server/db";
import { recordAudit, userAuditCtx, AuditAction } from "~/server/service/audit-service";

export const teamRouter = createTRPCRouter({
  createTeam: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return TeamService.createTeam(ctx.session.user.id, input.name);
    }),

  getTeams: protectedProcedure.query(async ({ ctx }) => {
    return TeamService.getUserTeams(ctx.session.user.id);
  }),

  getTeamUsers: teamProcedure.query(async ({ ctx }) => {
    return TeamService.getTeamUsers(ctx.team.id);
  }),

  getTeamInvites: teamProcedure.query(async ({ ctx }) => {
    return TeamService.getTeamInvites(ctx.team.id);
  }),

  createTeamInvite: teamAdminProcedure
    .input(
      z.object({
        email: z.string(),
        role: z.enum(["MEMBER", "ADMIN", "DEVELOPER"]),
        sendEmail: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await TeamService.createTeamInvite(
        ctx.team.id,
        input.email,
        input.role,
        ctx.team.name,
        input.sendEmail,
      );
      await recordAudit(
        userAuditCtx(ctx.team.id, ctx.session.user.id),
        AuditAction.MEMBER_INVITED,
        { metadata: { email: input.email, role: input.role } },
      );
      return result;
    }),

  updateTeamUserRole: teamAdminProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(["MEMBER", "ADMIN", "DEVELOPER"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await TeamService.updateTeamUserRole(
        ctx.team.id,
        input.userId,
        input.role,
      );
      await recordAudit(
        userAuditCtx(ctx.team.id, ctx.session.user.id),
        AuditAction.MEMBER_ROLE_CHANGED,
        { targetType: "user", targetId: input.userId, metadata: { role: input.role } },
      );
      return result;
    }),

  deleteTeamUser: teamProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await TeamService.deleteTeamUser(
        ctx.team.id,
        input.userId,
        ctx.teamUser.role,
        ctx.session.user.id,
      );
      await recordAudit(
        userAuditCtx(ctx.team.id, ctx.session.user.id),
        AuditAction.MEMBER_REMOVED,
        { targetType: "user", targetId: input.userId },
      );
      return result;
    }),

  resendTeamInvite: teamAdminProcedure
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return TeamService.resendTeamInvite(
        ctx.team.id,
        input.inviteId,
        ctx.team.name,
      );
    }),

  deleteTeamInvite: teamAdminProcedure
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return TeamService.deleteTeamInvite(ctx.team.id, input.inviteId);
    }),

  /**
   * Set the dedicated IP pool for this team (admin-only).
   * The pool name must match a set of OCI_SMTP_POOL_<NAME>_* env vars on the server.
   * Pass null to revert to the shared pool.
   */
  setSendingPool: teamAdminProcedure
    .input(z.object({ sendingPool: z.string().max(64).nullable() }))
    .mutation(async ({ ctx, input }) => {
      await db.team.update({
        where: { id: ctx.team.id },
        data: { sendingPool: input.sendingPool },
      });
      await recordAudit(
        userAuditCtx(ctx.team.id, ctx.session.user.id),
        AuditAction.SENDING_POOL_CHANGED,
        { metadata: { sendingPool: input.sendingPool } },
      );
      return { sendingPool: input.sendingPool };
    }),

  getSendingPool: teamAdminProcedure.query(async ({ ctx }) => {
    const team = await db.team.findUnique({
      where: { id: ctx.team.id },
      select: { sendingPool: true },
    });
    return { sendingPool: team?.sendingPool ?? null };
  }),
});
