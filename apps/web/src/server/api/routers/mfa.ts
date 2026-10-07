/**
 * MFA router – TOTP enrollment, challenge verification, recovery codes, admin reset.
 *
 * The 2FA challenge flow in NextAuth (database-session mode):
 *   1. User signs in normally → session is created with twoFactorVerifiedAt = null.
 *   2. On the first `protectedProcedure` call the middleware checks if the user
 *      has totpEnabled AND the team requiresTwoFactor.  If so, it throws UNAUTHORIZED
 *      with code "MFA_REQUIRED" unless the path is one of the allowed bypass routes.
 *   3. The frontend redirects to /mfa/challenge where the user enters their TOTP.
 *   4. `mfa.verifyChallenge` verifies the token and writes twoFactorVerifiedAt on
 *      the current DB session row.
 *   5. Subsequent requests pass the middleware check.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { withMfaAttemptGuard } from "~/server/service/mfa-attempt-guard";
import { createTRPCRouter, protectedProcedure, teamAdminProcedure, teamProcedure } from "~/server/api/trpc";
import {
  generateEnrollment,
  confirmEnrollment,
  verifyChallenge,
  verifyRecoveryCode,
  disableTotp,
  regenerateRecoveryCodes,
  getRemainingRecoveryCodeCount,
} from "~/server/service/totp-service";
import {
  recordAudit,
  userAuditCtx,
  AuditAction,
} from "~/server/service/audit-service";
import { db } from "~/server/db";

export const mfaRouter = createTRPCRouter({
  /**
   * Start TOTP enrollment: generates a new secret and QR code.
   * The returned `secret` must be passed back to `confirmEnrollment`.
   */
  startEnrollment: protectedProcedure.mutation(async ({ ctx }) => {
    const user = await db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { email: true, totpEnabled: true },
    });
    if (!user) throw new TRPCError({ code: "NOT_FOUND" });

    if (user.totpEnabled) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "TOTP is already enabled. Disable it first.",
      });
    }

    const enrollment = await generateEnrollment(
      ctx.session.user.id,
      user.email ?? "user",
    );

    return {
      secret: enrollment.secret,
      qrDataUri: enrollment.qrDataUri,
      otpauthUrl: enrollment.otpauthUrl,
    };
  }),

  /**
   * Confirm TOTP enrollment with the user's first token.
   * Returns one-time recovery codes (shown exactly once).
   */
  confirmEnrollment: protectedProcedure
    .input(
      z.object({
        secret: z.string().min(1),
        token: z.string().length(6).regex(/^\d{6}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { recoveryCodes } = await confirmEnrollment(
        ctx.session.user.id,
        input.secret,
        input.token,
      ).catch((err: Error) => {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err.message,
        });
      });

      // Mark the current session as 2FA-verified
      await db.session.updateMany({
        where: { userId: ctx.session.user.id },
        data: { twoFactorVerifiedAt: new Date() },
      });

      // Audit
      const teamUser = await db.teamUser.findFirst({
        where: { userId: ctx.session.user.id },
        select: { teamId: true },
      });
      if (teamUser) {
        await recordAudit(
          userAuditCtx(teamUser.teamId, ctx.session.user.id),
          AuditAction.MFA_ENROLLED,
          { targetType: "user", targetId: ctx.session.user.id },
        );
      }

      return { recoveryCodes };
    }),

  /**
   * Verify a TOTP challenge during an active session (post-sign-in second factor).
   * Marks the session as 2FA-verified on success.
   */
  verifyChallenge: protectedProcedure
    .input(
      z.object({
        token: z.string().min(6).max(6),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const valid = await withMfaAttemptGuard(ctx.session.user.id, () =>
        verifyChallenge(ctx.session.user.id, input.token),
      );
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid TOTP token",
        });
      }

      await db.session.updateMany({
        where: { userId: ctx.session.user.id },
        data: { twoFactorVerifiedAt: new Date() },
      });

      const teamUser = await db.teamUser.findFirst({
        where: { userId: ctx.session.user.id },
        select: { teamId: true },
      });
      if (teamUser) {
        await recordAudit(
          userAuditCtx(teamUser.teamId, ctx.session.user.id),
          AuditAction.MFA_CHALLENGE_PASSED,
          { targetType: "user", targetId: ctx.session.user.id },
        );
      }

      return { verified: true };
    }),

  /**
   * Verify a one-time recovery code (burns it on success).
   */
  verifyRecoveryCode: protectedProcedure
    .input(z.object({ code: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const valid = await withMfaAttemptGuard(ctx.session.user.id, () =>
        verifyRecoveryCode(ctx.session.user.id, input.code),
      );
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid or already-used recovery code",
        });
      }

      await db.session.updateMany({
        where: { userId: ctx.session.user.id },
        data: { twoFactorVerifiedAt: new Date() },
      });

      const teamUser = await db.teamUser.findFirst({
        where: { userId: ctx.session.user.id },
        select: { teamId: true },
      });
      if (teamUser) {
        await recordAudit(
          userAuditCtx(teamUser.teamId, ctx.session.user.id),
          AuditAction.MFA_RECOVERY_USED,
          { targetType: "user", targetId: ctx.session.user.id },
        );
      }

      return { verified: true };
    }),

  /**
   * Disable TOTP for the current user (requires a valid token to confirm intent).
   */
  disable: protectedProcedure
    .input(
      z.object({
        token: z.string().length(6).regex(/^\d{6}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const valid = await withMfaAttemptGuard(ctx.session.user.id, () =>
        verifyChallenge(ctx.session.user.id, input.token),
      );
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid TOTP token – provide a current code to disable MFA",
        });
      }

      await disableTotp(ctx.session.user.id);

      const teamUser = await db.teamUser.findFirst({
        where: { userId: ctx.session.user.id },
        select: { teamId: true },
      });
      if (teamUser) {
        await recordAudit(
          userAuditCtx(teamUser.teamId, ctx.session.user.id),
          AuditAction.MFA_DISABLED,
          { targetType: "user", targetId: ctx.session.user.id },
        );
      }

      return { disabled: true };
    }),

  /** Regenerate recovery codes (requires a valid token). */
  regenerateRecoveryCodes: protectedProcedure
    .input(z.object({ token: z.string().length(6).regex(/^\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      const valid = await withMfaAttemptGuard(ctx.session.user.id, () =>
        verifyChallenge(ctx.session.user.id, input.token),
      );
      if (!valid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid TOTP token" });
      }

      const recoveryCodes = await regenerateRecoveryCodes(ctx.session.user.id);
      return { recoveryCodes };
    }),

  /** Returns the count of remaining recovery codes (not the codes themselves). */
  getRecoveryCodeCount: protectedProcedure.query(async ({ ctx }) => {
    const count = await getRemainingRecoveryCodeCount(ctx.session.user.id);
    return { count };
  }),

  /** Returns whether the current user has TOTP enabled. */
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { totpEnabled: true },
    });
    return { totpEnabled: user?.totpEnabled ?? false };
  }),

  /**
   * Admin: reset another user's TOTP (team admin only, targets a team member).
   * The target user must re-enroll on next login.
   */
  adminReset: teamAdminProcedure
    .input(z.object({ targetUserId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      // Ensure the target user is a member of the same team
      const targetTeamUser = await db.teamUser.findUnique({
        where: { teamId_userId: { teamId: ctx.team.id, userId: input.targetUserId } },
      });
      if (!targetTeamUser) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found in this team" });
      }

      await disableTotp(input.targetUserId);

      await recordAudit(
        userAuditCtx(ctx.team.id, ctx.session.user.id),
        AuditAction.MFA_ADMIN_RESET,
        { targetType: "user", targetId: input.targetUserId },
      );

      return { reset: true };
    }),

  // ─── Team-level 2FA requirement ──────────────────────────────────────────────

  /**
   * Require all team members to use TOTP (admin only).
   */
  setTeamRequireTwoFactor: teamAdminProcedure
    .input(z.object({ require: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await db.team.update({
        where: { id: ctx.team.id },
        data: { requireTwoFactor: input.require },
      });

      await recordAudit(
        userAuditCtx(ctx.team.id, ctx.session.user.id),
        AuditAction.REQUIRE_2FA_CHANGED,
        { metadata: { requireTwoFactor: input.require } },
      );

      return { requireTwoFactor: input.require };
    }),

  getTeamRequireTwoFactor: teamProcedure.query(async ({ ctx }) => {
    return { requireTwoFactor: ctx.team.requireTwoFactor };
  }),
});
