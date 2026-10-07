/**
 * tRPC router for received (inbound) emails — used by the dashboard.
 *
 * The public REST API (Resend-compat) lives in
 * `apps/web/src/server/public-api/resend/received.ts`.
 */

import { z } from "zod";
import { DEFAULT_QUERY_LIMIT } from "~/lib/constants";
import { createTRPCRouter, teamProcedure } from "~/server/api/trpc";
import {
  getReceivedEmails,
  getReceivedEmailById,
  toResendReceivedEmail,
} from "~/server/service/received-email-service";
import { setDomainReceiving } from "~/server/service/domain-receiving";

export const receivedEmailRouter = createTRPCRouter({
  /** Paginated list of received emails for the team. */
  list: teamProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(DEFAULT_QUERY_LIMIT),
        after: z.string().optional(),
        before: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { data, has_more } = await getReceivedEmails(ctx.team.id, input);
      const resendData = await Promise.all(data.map(toResendReceivedEmail));
      return { data: resendData, has_more };
    }),

  /** Get a single received email by id. */
  get: teamProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await getReceivedEmailById(ctx.team.id, input.id);
      if (!row) return null;
      return toResendReceivedEmail(row);
    }),

  /** Enable or disable receiving on a domain. */
  setReceiving: teamProcedure
    .input(
      z.object({
        domainId: z.number().int(),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return setDomainReceiving(ctx.team.id, input.domainId, input.enabled);
    }),
});
