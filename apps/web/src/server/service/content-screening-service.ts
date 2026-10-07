import { env } from "~/env";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { sendMail } from "~/server/mailer";
import { getRedis, redisKey } from "~/server/redis";
import { UnsendApiError } from "~/server/public-api/api-error";
import { SCREENING_POLICY } from "~/lib/constants/sending-policy";
import {
  describeFindings,
  screenContent,
  type ScreeningInput,
  type ScreeningVerdict,
} from "~/server/screening/content-rules";
import {
  getThreatIndex,
  parseListEnv,
} from "~/server/screening/threat-feed-store";
import { TeamService } from "./team-service";

const DAY_SECONDS = 24 * 60 * 60;

const ALLOW_VERDICT: ScreeningVerdict = {
  action: "allow",
  score: 0,
  strike: false,
  findings: [],
};

function ownHosts(): string[] {
  try {
    return [new URL(env.NEXTAUTH_URL).hostname];
  } catch {
    return [];
  }
}

export type StrikeResult = { strikes: number; blocked: boolean };

export class ContentScreeningService {
  /** Screens one outgoing email; always "allow" when screening is disabled. */
  static async screen(input: ScreeningInput): Promise<ScreeningVerdict> {
    if (!env.CONTENT_SCREENING_ENABLED) return ALLOW_VERDICT;

    const index = await getThreatIndex([
      ...parseListEnv(env.SCREENING_ALLOWLIST_DOMAINS),
      ...ownHosts(),
    ]);
    return screenContent(input, {
      isListedHost: (host) => index.isListed(host),
      blockedDomains: parseListEnv(env.SCREENING_BLOCKED_DOMAINS),
    });
  }

  /**
   * Counts a malicious-content rejection against the team. Repeat offenses
   * within the window block the team until an admin unblocks it.
   */
  static async recordStrike(
    teamId: number,
    verdict: ScreeningVerdict,
    now = new Date(),
  ): Promise<StrikeResult> {
    const key = redisKey(`screening:strikes:${teamId}`);
    const redis = getRedis();
    const strikes = await redis.incr(key);
    if (strikes === 1) {
      await redis.expire(key, SCREENING_POLICY.strikeWindowDays * DAY_SECONDS);
    }
    logger.warn(
      { teamId, strikes, findings: verdict.findings },
      "[ContentScreening]: Malicious content rejected",
    );

    if (strikes < SCREENING_POLICY.strikesToBlock) {
      return { strikes, blocked: false };
    }

    const reason =
      `CONTENT: ${strikes} malicious-content rejections in ${SCREENING_POLICY.strikeWindowDays} days (${describeFindings(verdict.findings)})`.slice(
        0,
        500,
      );
    const { count } = await db.team.updateMany({
      where: { id: teamId, isBlocked: false },
      data: { isBlocked: true, blockedReason: reason, blockedAt: now },
    });
    await TeamService.invalidateTeamCache(teamId);
    if (count > 0) {
      logger.warn({ teamId, reason }, "[ContentScreening]: Team blocked");
      await ContentScreeningService.notifyAdmin(
        `[admin] Scribase Mail: team ${teamId} blocked for malicious content`,
        `${reason}\n\n${env.NEXTAUTH_URL}/admin/teams`,
      );
    }
    return { strikes, blocked: true };
  }

  /**
   * Synchronous check for the API/SMTP and campaign paths so callers get a
   * clear error instead of a silently failed email. Hold verdicts pass here
   * and are held by the send queue.
   */
  static async assertSendable(
    teamId: number,
    input: ScreeningInput,
  ): Promise<ScreeningVerdict> {
    const verdict = await ContentScreeningService.screen(input);
    if (verdict.action !== "reject") return verdict;

    if (verdict.strike) {
      await ContentScreeningService.recordStrike(teamId, verdict);
    }
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: `Email rejected by content screening: ${describeFindings(verdict.findings)}`,
    });
  }

  static async notifyAdmin(subject: string, text: string): Promise<void> {
    if (!env.ADMIN_EMAIL) return;
    try {
      const html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .split("\n\n")
        .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
        .join("");
      await sendMail(
        env.ADMIN_EMAIL,
        subject.replace(/[\r\n]/g, " "),
        text,
        html,
      );
    } catch (error) {
      logger.error(
        { err: error, subject },
        "[ContentScreening]: Failed to notify admin",
      );
    }
  }
}
