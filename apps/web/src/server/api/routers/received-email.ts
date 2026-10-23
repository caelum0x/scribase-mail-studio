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
  replyToReceivedEmail,
  forwardReceivedEmail,
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

  /** Reply to a received email, threaded via In-Reply-To/References. */
  reply: teamProcedure
    .input(
      z.object({
        id: z.string(),
        from: z.string().email().or(z.string().min(3)),
        to: z.string().email().optional(),
        cc: z.array(z.string().email()).optional(),
        text: z.string().optional(),
        html: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sent = await replyToReceivedEmail(ctx.team.id, input.id, {
        from: input.from,
        to: input.to,
        cc: input.cc,
        text: input.text,
        html: input.html,
      });
      return { id: sent.id };
    }),

  /** Forward a received email to a new recipient, carrying attachments. */
  forward: teamProcedure
    .input(
      z.object({
        id: z.string(),
        from: z.string().email().or(z.string().min(3)),
        to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
        cc: z.array(z.string().email()).optional(),
        comment: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sent = await forwardReceivedEmail(ctx.team.id, input.id, {
        from: input.from,
        to: input.to,
        cc: input.cc,
        comment: input.comment,
      });
      return { id: sent.id };
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
