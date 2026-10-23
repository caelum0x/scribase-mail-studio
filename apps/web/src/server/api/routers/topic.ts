/**
 * Topic router — team-side CRUD for subscription topics, plus the public
 * (unauthenticated) preference-center endpoints used by /unsubscribe so a
 * recipient can opt out of one topic while staying subscribed to others.
 */
import { TopicSubscription, TopicVisibility } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createTRPCRouter,
  publicProcedure,
  teamProcedure,
} from "~/server/api/trpc";
import { TopicService } from "~/server/service/topic-service";

function toTrpcError(error: unknown): never {
  if (error instanceof TRPCError) {
    throw error;
  }
  if (error instanceof Error) {
    const notFound = /not found/i.test(error.message);
    const invalidLink = /invalid unsubscribe link/i.test(error.message);
    throw new TRPCError({
      code: notFound ? "NOT_FOUND" : invalidLink ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR",
      message: error.message,
    });
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
}

export const topicRouter = createTRPCRouter({
  // ── Team-side CRUD ───────────────────────────────────────────────────

  list: teamProcedure.query(async ({ ctx }) => {
    return TopicService.list(ctx.team.id);
  }),

  create: teamProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        defaultSubscription: z.nativeEnum(TopicSubscription).optional(),
        visibility: z.nativeEnum(TopicVisibility).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await TopicService.create(ctx.team.id, input);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  update: teamProcedure
    .input(
      z.object({
        topicId: z.string(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        defaultSubscription: z.nativeEnum(TopicSubscription).optional(),
        visibility: z.nativeEnum(TopicVisibility).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { topicId, ...data } = input;
      try {
        return await TopicService.update(ctx.team.id, topicId, data);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  delete: teamProcedure
    .input(z.object({ topicId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await TopicService.delete(ctx.team.id, input.topicId);
        return { success: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  // ── Public preference center (no auth — identity comes from the signed
  //    unsubscribe link id/hash pair, same as /unsubscribe) ──────────────

  getPublicPreferences: publicProcedure
    .input(z.object({ id: z.string(), hash: z.string() }))
    .query(async ({ input }) => {
      try {
        return await TopicService.getPublicPreferencesFromLink(
          input.id,
          input.hash,
        );
      } catch (error) {
        toTrpcError(error);
      }
    }),

  updatePublicPreferences: publicProcedure
    .input(
      z.object({
        id: z.string(),
        hash: z.string(),
        topics: z
          .array(
            z.object({
              topicId: z.string(),
              subscribed: z.boolean(),
            }),
          )
          .max(200),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await TopicService.updatePublicPreferencesFromLink(
          input.id,
          input.hash,
          input.topics,
        );
      } catch (error) {
        toTrpcError(error);
      }
    }),
});
