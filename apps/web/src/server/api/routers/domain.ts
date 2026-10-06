import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  createTRPCRouter,
  teamProcedure,
  protectedProcedure,
  domainProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  createDomain,
  deleteDomain,
  getDomain,
  getDomains,
  updateDomain,
} from "~/server/service/domain-service";
import { sendEmail } from "~/server/service/email-service";
import { ProviderSettingsService } from "~/server/service/provider-settings-service";
import { getEmailProvider } from "~/server/provider";

export const domainRouter = createTRPCRouter({
  getAvailableRegions: protectedProcedure.query(async () => {
    return ProviderSettingsService.getAvailableRegions();
  }),

  createDomain: teamProcedure
    .input(
      z.object({
        name: z.string().trim().min(1),
        region: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return createDomain(ctx.team.id, input.name, input.region);
    }),

  approvedSenders: domainProcedure.query(async ({ ctx }) => {
    return getEmailProvider().listApprovedSenders(ctx.domain.name);
  }),

  addApprovedSender: domainProcedure
    .input(
      z.object({
        localPart: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9._%+-]+$/, "Invalid sender address"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.domain.status !== "SUCCESS") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Verify the domain before adding senders",
        });
      }
      const email = `${input.localPart.toLowerCase()}@${ctx.domain.name}`;
      await getEmailProvider().ensureApprovedSender(email);
      return { email };
    }),

  startVerification: domainProcedure.mutation(async ({ ctx, input }) => {
    await ctx.db.domain.update({
      where: { id: input.id },
      data: { isVerifying: true },
    });
  }),

  domains: teamProcedure.query(async ({ ctx }) => {
    return getDomains(ctx.team.id);
  }),

  getDomain: domainProcedure.query(async ({ input, ctx }) => {
    return getDomain(input.id, ctx.team.id);
  }),

  updateDomain: domainProcedure
    .input(
      z.object({
        clickTracking: z.boolean().optional(),
        openTracking: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return updateDomain(input.id, {
        clickTracking: input.clickTracking,
        openTracking: input.openTracking,
      });
    }),

  deleteDomain: domainProcedure.mutation(async ({ input }) => {
    await deleteDomain(input.id);
    return { success: true };
  }),

  sendTestEmailFromDomain: domainProcedure.mutation(
    async ({
      ctx: {
        session: { user },
        team,
      },
      input,
    }) => {
      const domain = await db.domain.findFirst({
        where: { id: input.id, teamId: team.id },
      });

      if (!domain) {
        throw new Error("Domain not found");
      }

      if (!user.email) {
        throw new Error("User email not found");
      }

      return sendEmail({
        teamId: team.id,
        to: user.email,
        from: `hello@${domain.name}`,
        subject: "Scribase Mail test email",
        text: "hello,\n\nThis is a test email from Scribase Mail.\n\nhttps://scribase.com",
        html: "<p>hello,</p><p>This is a test email from Scribase Mail.</p><p><a href='https://scribase.com'>scribase.com</a></p>",
      });
    },
  ),
});
