import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getThisMonthUsage } from "~/server/service/usage-service";

import {
  createTRPCRouter,
  teamAdminProcedure,
  teamProcedure,
} from "~/server/api/trpc";
import {
  BillingNotConfiguredError,
  getProductIds,
  isBillingConfigured,
} from "~/server/billing/dodo-client";
import {
  BillingError,
  cancelTeamSubscription,
  changeTeamPlan,
  createCheckoutSessionForTeam,
  getManageSessionUrl,
  resumeTeamSubscription,
} from "~/server/billing/payments";
import { PAID_PLANS } from "~/server/billing/plan-mapping";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { TeamService } from "~/server/service/team-service";

const paidPlanInput = z.object({ plan: z.enum(["PRO", "SCALE"]) });

/** Map billing failures to client-safe tRPC errors (no provider internals). */
async function billingCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Billing not configured",
      });
    }
    if (err instanceof BillingError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    logger.error({ err }, "[Billing]: Provider call failed");
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Billing provider error. Please try again.",
    });
  }
}

export const billingRouter = createTRPCRouter({
  getBillingStatus: teamProcedure.query(() => {
    const productIds = getProductIds();
    return {
      configured: isBillingConfigured(),
      availablePlans: PAID_PLANS.filter((plan) => Boolean(productIds[plan])),
    };
  }),

  createCheckoutSession: teamAdminProcedure
    .input(paidPlanInput)
    .mutation(async ({ ctx, input }) => {
      const session = await billingCall(() =>
        createCheckoutSessionForTeam(ctx.team.id, input.plan),
      );
      return session.url;
    }),

  changePlan: teamAdminProcedure
    .input(paidPlanInput)
    .mutation(async ({ ctx, input }) => {
      await billingCall(() => changeTeamPlan(ctx.team.id, input.plan));
      return { ok: true };
    }),

  cancelSubscription: teamAdminProcedure.mutation(async ({ ctx }) => {
    await billingCall(() => cancelTeamSubscription(ctx.team.id));
    return { ok: true };
  }),

  resumeSubscription: teamAdminProcedure.mutation(async ({ ctx }) => {
    await billingCall(() => resumeTeamSubscription(ctx.team.id));
    return { ok: true };
  }),

  getManageSessionUrl: teamAdminProcedure.mutation(async ({ ctx }) => {
    return billingCall(() => getManageSessionUrl(ctx.team.id));
  }),

  getThisMonthUsage: teamProcedure.query(async ({ ctx }) => {
    return await getThisMonthUsage(ctx.team.id);
  }),

  getSubscriptionDetails: teamProcedure.query(async ({ ctx }) => {
    return db.subscription.findFirst({
      where: { teamId: ctx.team.id },
      orderBy: { updatedAt: "desc" },
    });
  }),

  updateBillingEmail: teamAdminProcedure
    .input(
      z.object({
        billingEmail: z.string().email(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { billingEmail } = input;

      await TeamService.updateTeam(ctx.team.id, { billingEmail });
    }),
});
