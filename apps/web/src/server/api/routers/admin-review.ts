import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, adminProcedure } from "~/server/api/trpc";
import {
  EmailReviewService,
  MAX_REVIEW_BATCH,
} from "~/server/service/email-review-service";
import { getThreatFeedMeta } from "~/server/screening/threat-feed-store";

const reviewIdsInput = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(MAX_REVIEW_BATCH);

function attachmentNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ filename?: unknown }>;
    return Array.isArray(parsed)
      ? parsed.map((a) => String(a?.filename ?? "attachment"))
      : [];
  } catch {
    return [];
  }
}

/** Review queue for held emails (content flags and new teams' first sends). */
export const adminReviewRouter = createTRPCRouter({
  list: adminProcedure
    .input(
      z.object({
        cursor: z.string().max(64).optional(),
        teamId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input }) => {
      return EmailReviewService.listPending({
        cursor: input.cursor,
        teamId: input.teamId,
      });
    }),

  preview: adminProcedure
    .input(z.object({ reviewId: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const review = await EmailReviewService.getPreview(input.reviewId);
      if (!review) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Review not found" });
      }
      // Attachment contents never leave the server; names are enough.
      const { attachments, ...email } = review.email;
      return {
        id: review.id,
        status: review.status,
        email: { ...email, attachments: attachmentNames(attachments) },
      };
    }),

  approve: adminProcedure
    .input(
      z.object({
        reviewIds: reviewIdsInput,
        trustTeam: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return EmailReviewService.approve({
        reviewIds: input.reviewIds,
        adminUserId: ctx.session.user.id,
        trustTeam: input.trustTeam,
      });
    }),

  approveTeam: adminProcedure
    .input(
      z.object({
        teamId: z.number().int().positive(),
        trustTeam: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return EmailReviewService.approveTeam({
        teamId: input.teamId,
        adminUserId: ctx.session.user.id,
        trustTeam: input.trustTeam,
      });
    }),

  reject: adminProcedure
    .input(
      z.object({
        reviewIds: reviewIdsInput,
        blockTeam: z.boolean().default(false),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return EmailReviewService.reject({
        reviewIds: input.reviewIds,
        adminUserId: ctx.session.user.id,
        blockTeam: input.blockTeam,
        note: input.note || undefined,
      });
    }),

  feedStatus: adminProcedure.query(async () => {
    return getThreatFeedMeta();
  }),
});
