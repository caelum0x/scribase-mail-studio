/**
 * Segment router — team-side CRUD and membership management for static
 * segments (SegmentService). Also exposes `createCampaignAudience`, which
 * snapshots a segment's current members into a brand-new contact book so a
 * sender can target "send to segment" from the existing campaign flow
 * without a schema change to Campaign.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, teamProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { SegmentService } from "~/server/service/segment-service";
import { createContactBook } from "~/server/service/contact-book-service";
import { UnsendApiError } from "~/server/public-api/api-error";

const TRPC_CODE_BY_API_CODE: Record<string, TRPCError["code"]> = {
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  BAD_REQUEST: "BAD_REQUEST",
  NOT_UNIQUE: "CONFLICT",
  UNAUTHORIZED: "UNAUTHORIZED",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
};

function toTrpcError(error: unknown): never {
  if (error instanceof TRPCError) {
    throw error;
  }
  if (error instanceof UnsendApiError) {
    throw new TRPCError({
      code: TRPC_CODE_BY_API_CODE[error.code] ?? "INTERNAL_SERVER_ERROR",
      message: error.message,
    });
  }
  if (error instanceof Error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
}

export const segmentRouter = createTRPCRouter({
  list: teamProcedure.query(async ({ ctx }) => {
    return SegmentService.list(ctx.team.id);
  }),

  get: teamProcedure
    .input(z.object({ segmentId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return await SegmentService.get(ctx.team.id, input.segmentId);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  create: teamProcedure
    .input(z.object({ name: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      return SegmentService.create(ctx.team.id, input.name);
    }),

  rename: teamProcedure
    .input(z.object({ segmentId: z.string(), name: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await SegmentService.update(ctx.team.id, input.segmentId, input.name);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  delete: teamProcedure
    .input(z.object({ segmentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await SegmentService.delete(ctx.team.id, input.segmentId);
        return { success: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  listContacts: teamProcedure
    .input(z.object({ segmentId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return await SegmentService.listContacts(ctx.team.id, input.segmentId);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  addContacts: teamProcedure
    .input(
      z.object({
        segmentId: z.string(),
        contactIds: z.array(z.string()).min(1).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const added = await SegmentService.addContacts(
          ctx.team.id,
          input.segmentId,
          input.contactIds,
        );
        return { count: added.length };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  removeContacts: teamProcedure
    .input(
      z.object({
        segmentId: z.string(),
        contactIds: z.array(z.string()).min(1).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await SegmentService.removeContacts(
          ctx.team.id,
          input.segmentId,
          input.contactIds,
        );
        return { success: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * Snapshot every current member of a segment into a new contact book, so
   * the existing campaign "To" picker (which only targets a whole contact
   * book) can be pointed at exactly this segment's recipients.
   */
  createCampaignAudience: teamProcedure
    .input(z.object({ segmentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      let segment;
      try {
        segment = await SegmentService.get(ctx.team.id, input.segmentId);
      } catch (error) {
        toTrpcError(error);
      }

      const contacts = await SegmentService.listContacts(
        ctx.team.id,
        input.segmentId,
      );

      if (contacts.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This segment has no contacts yet. Add contacts before sending to it.",
        });
      }

      const newBook = await createContactBook(
        ctx.team.id,
        `${segment!.name} — segment snapshot ${new Date().toISOString().split("T")[0]}`,
      );

      await db.contact.createMany({
        data: contacts.map((c) => ({
          contactBookId: newBook.id,
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          properties: c.properties ?? {},
          subscribed: c.subscribed,
        })),
        skipDuplicates: true,
      });

      return { contactBookId: newBook.id, count: contacts.length };
    }),
});
