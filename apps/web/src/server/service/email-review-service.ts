import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { getProviderRegion } from "~/server/provider";
import { EmailQueueService } from "./email-queue-service";
import { TeamService } from "./team-service";

/**
 * Admin decisions on held emails. Approving queues the email again with
 * `reviewApproved` so the send gate lets it through; rejecting fails it and
 * can block the team.
 */

export const MAX_REVIEW_BATCH = 200;

export type ApproveResult = { approved: number; failed: number };
export type RejectResult = { rejected: number; blockedTeams: number[] };

export class EmailReviewService {
  static async listPending({
    teamId,
    cursor,
    limit = 50,
  }: {
    teamId?: number;
    cursor?: string;
    limit?: number;
  }) {
    const items = await db.emailReview.findMany({
      where: { status: "PENDING", ...(teamId ? { teamId } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        emailId: true,
        teamId: true,
        reason: true,
        score: true,
        findings: true,
        createdAt: true,
        team: {
          select: {
            name: true,
            createdAt: true,
            isBlocked: true,
            sendingTrustedAt: true,
          },
        },
        email: {
          select: {
            from: true,
            to: true,
            cc: true,
            bcc: true,
            subject: true,
            campaignId: true,
          },
        },
      },
    });
    // Cursor is the last returned row; the next page skips it.
    const nextCursor = items.length > limit ? items[limit - 1]?.id : undefined;
    const pendingTotal = await db.emailReview.count({
      where: { status: "PENDING" },
    });
    return { items: items.slice(0, limit), nextCursor, pendingTotal };
  }

  static async getPreview(reviewId: string) {
    return db.emailReview.findUnique({
      where: { id: reviewId },
      select: {
        id: true,
        status: true,
        email: {
          select: {
            id: true,
            from: true,
            to: true,
            replyTo: true,
            subject: true,
            html: true,
            text: true,
            attachments: true,
          },
        },
      },
    });
  }

  private static async regionFor(
    domainId: number | null,
    cache: Map<number, string>,
  ) {
    if (!domainId) return getProviderRegion();
    const known = cache.get(domainId);
    if (known) return known;
    const domain = await db.domain.findUnique({
      where: { id: domainId },
      select: { region: true },
    });
    const region = domain?.region ?? getProviderRegion();
    cache.set(domainId, region);
    return region;
  }

  private static async trustTeams(teamIds: number[], now: Date) {
    if (teamIds.length === 0) return;
    await db.team.updateMany({
      where: { id: { in: teamIds }, sendingTrustedAt: null },
      data: { sendingTrustedAt: now },
    });
    await Promise.all(teamIds.map((id) => TeamService.invalidateTeamCache(id)));
  }

  static async approve({
    reviewIds,
    adminUserId,
    trustTeam,
    now = new Date(),
  }: {
    reviewIds: string[];
    adminUserId: number;
    trustTeam: boolean;
    now?: Date;
  }): Promise<ApproveResult> {
    const reviews = await db.emailReview.findMany({
      where: {
        id: { in: reviewIds.slice(0, MAX_REVIEW_BATCH) },
        status: "PENDING",
      },
      select: {
        id: true,
        emailId: true,
        teamId: true,
        unsubUrl: true,
        isBulk: true,
        email: { select: { domainId: true } },
      },
    });

    const regions = new Map<number, string>();
    const result: ApproveResult = { approved: 0, failed: 0 };

    for (const review of reviews) {
      // Claim the review so two admins can't queue the same email twice.
      const claimed = await db.emailReview.updateMany({
        where: { id: review.id, status: "PENDING" },
        data: { status: "APPROVED", decidedAt: now, decidedBy: adminUserId },
      });
      if (claimed.count === 0) continue;

      await db.$transaction([
        db.email.update({
          where: { id: review.emailId },
          data: { latestStatus: "QUEUED" },
        }),
        db.emailEvent.create({
          data: {
            emailId: review.emailId,
            status: "QUEUED",
            data: { message: "Approved by Scribase Mail review" },
            teamId: review.teamId,
          },
        }),
      ]);

      try {
        const region = await EmailReviewService.regionFor(
          review.email.domainId,
          regions,
        );
        await EmailQueueService.queueEmail(
          review.emailId,
          review.teamId,
          region,
          !review.isBulk,
          review.unsubUrl ?? undefined,
          undefined,
          { reviewApproved: true },
        );
        result.approved += 1;
      } catch (error) {
        logger.error(
          { err: error, emailId: review.emailId },
          "[EmailReview]: Failed to queue approved email",
        );
        await db.$transaction([
          db.email.update({
            where: { id: review.emailId },
            data: { latestStatus: "FAILED" },
          }),
          db.emailEvent.create({
            data: {
              emailId: review.emailId,
              status: "FAILED",
              data: { error: "Could not queue the email after review" },
              teamId: review.teamId,
            },
          }),
        ]);
        result.failed += 1;
      }
    }

    if (trustTeam) {
      await EmailReviewService.trustTeams(
        [...new Set(reviews.map((r) => r.teamId))],
        now,
      );
    }
    logger.info(
      { ...result, adminUserId, trustTeam },
      "[EmailReview]: Approved",
    );
    return result;
  }

  /** Approves every pending email of one team (e.g. a held campaign). */
  static async approveTeam({
    teamId,
    adminUserId,
    trustTeam,
    now = new Date(),
  }: {
    teamId: number;
    adminUserId: number;
    trustTeam: boolean;
    now?: Date;
  }): Promise<ApproveResult> {
    const total: ApproveResult = { approved: 0, failed: 0 };
    if (trustTeam) await EmailReviewService.trustTeams([teamId], now);
    // Batches keep memory flat for large held campaigns.
    for (;;) {
      const pending = await db.emailReview.findMany({
        where: { teamId, status: "PENDING" },
        select: { id: true },
        take: MAX_REVIEW_BATCH,
      });
      if (pending.length === 0) break;
      const result = await EmailReviewService.approve({
        reviewIds: pending.map((p) => p.id),
        adminUserId,
        trustTeam: false,
        now,
      });
      total.approved += result.approved;
      total.failed += result.failed;
      if (result.approved + result.failed === 0) break;
    }
    return total;
  }

  static async reject({
    reviewIds,
    adminUserId,
    blockTeam,
    note,
    now = new Date(),
  }: {
    reviewIds: string[];
    adminUserId: number;
    blockTeam: boolean;
    note?: string;
    now?: Date;
  }): Promise<RejectResult> {
    const selected = await db.emailReview.findMany({
      where: {
        id: { in: reviewIds.slice(0, MAX_REVIEW_BATCH) },
        status: "PENDING",
      },
      select: { teamId: true },
    });
    const teamIds = [...new Set(selected.map((r) => r.teamId))];
    const error = note
      ? `Rejected by Scribase Mail review: ${note}`
      : "Rejected by Scribase Mail review";

    if (blockTeam && teamIds.length > 0) {
      await db.team.updateMany({
        where: { id: { in: teamIds }, isBlocked: false },
        data: {
          isBlocked: true,
          blockedReason:
            `REVIEW: ${note ?? "held email rejected by admin"}`.slice(0, 500),
          blockedAt: now,
        },
      });
      await Promise.all(
        teamIds.map((id) => TeamService.invalidateTeamCache(id)),
      );
    }

    // A blocked team's other held emails are rejected with it.
    const where = blockTeam
      ? { teamId: { in: teamIds }, status: "PENDING" as const }
      : {
          id: { in: reviewIds.slice(0, MAX_REVIEW_BATCH) },
          status: "PENDING" as const,
        };

    let rejected = 0;
    for (;;) {
      const batch = await db.emailReview.findMany({
        where,
        select: { id: true, emailId: true, teamId: true },
        take: MAX_REVIEW_BATCH,
      });
      if (batch.length === 0) break;
      for (const review of batch) {
        const claimed = await db.emailReview.updateMany({
          where: { id: review.id, status: "PENDING" },
          data: { status: "REJECTED", decidedAt: now, decidedBy: adminUserId },
        });
        if (claimed.count === 0) continue;
        await db.$transaction([
          db.email.update({
            where: { id: review.emailId },
            data: { latestStatus: "FAILED" },
          }),
          db.emailEvent.create({
            data: {
              emailId: review.emailId,
              status: "FAILED",
              data: { error },
              teamId: review.teamId,
            },
          }),
        ]);
        rejected += 1;
      }
      if (!blockTeam) break;
    }

    logger.info(
      { rejected, adminUserId, blockTeam, teamIds },
      "[EmailReview]: Rejected",
    );
    return { rejected, blockedTeams: blockTeam ? teamIds : [] };
  }
}
