import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import {
  evaluateReputation,
  REPUTATION_POLICY,
  type ReputationResult,
} from "~/lib/constants/sending-policy";
import { TeamService } from "./team-service";

const DAY_MS = 24 * 60 * 60 * 1000;

// eslint-disable-next-line no-unused-vars -- parameter names in type signature
export type ReputationNotifier = (teamId: number, result: ReputationResult) => Promise<void>;

export type GuardResult = { checked: number; warned: number; paused: number };

function windowStart(now: Date): string {
  // windowDays calendar dates, today included.
  const since = new Date(
    now.getTime() - (REPUTATION_POLICY.windowDays - 1) * DAY_MS,
  );
  return since.toISOString().split("T")[0] as string; // YYYY-MM-DD, same as DailyEmailUsage.date
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

export function describeReputation(result: ReputationResult): string {
  return `${result.reason ?? "OK"}: bounce ${formatPercent(result.bounceRate)}, complaint ${formatPercent(result.complaintRate)} over ${REPUTATION_POLICY.windowDays} days`;
}

async function safeNotify(
  notify: ReputationNotifier,
  teamId: number,
  result: ReputationResult,
) {
  try {
    await notify(teamId, result);
  } catch (error) {
    logger.error(
      { err: error, teamId, status: result.status },
      "[ReputationGuard]: Failed to send reputation notification",
    );
  }
}

/**
 * Checks every team that sent mail in the reputation window. Teams over the
 * pause threshold are blocked (sending stops in LimitService.checkEmailLimit)
 * until an admin unblocks them; teams in the warning band are notified.
 */
export async function runReputationGuard({
  now = new Date(),
  notify,
}: {
  now?: Date;
  notify: ReputationNotifier;
}): Promise<GuardResult> {
  const usage = await db.dailyEmailUsage.groupBy({
    by: ["teamId"],
    where: { date: { gte: windowStart(now) } },
    _sum: { sent: true, hardBounced: true, complained: true },
  });

  const alreadyBlocked = await db.team.findMany({
    where: { id: { in: usage.map((u) => u.teamId) }, isBlocked: true },
    select: { id: true },
  });
  const blockedIds = new Set(alreadyBlocked.map((t) => t.id));

  const result: GuardResult = { checked: 0, warned: 0, paused: 0 };

  for (const row of usage) {
    if (blockedIds.has(row.teamId)) continue;
    result.checked += 1;

    const reputation = evaluateReputation({
      sent: row._sum.sent ?? 0,
      hardBounced: row._sum.hardBounced ?? 0,
      complained: row._sum.complained ?? 0,
    });

    if (reputation.status === "paused") {
      await db.team.update({
        where: { id: row.teamId },
        data: {
          isBlocked: true,
          blockedReason: describeReputation(reputation),
          blockedAt: now,
        },
      });
      await TeamService.invalidateTeamCache(row.teamId);
      logger.warn(
        { teamId: row.teamId, ...reputation },
        "[ReputationGuard]: Team paused",
      );
      result.paused += 1;
      await safeNotify(notify, row.teamId, reputation);
    } else if (reputation.status === "warning") {
      result.warned += 1;
      await safeNotify(notify, row.teamId, reputation);
    }
  }

  return result;
}
