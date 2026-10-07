import type { EmailReviewReason, Prisma } from "@prisma/client";
import { env } from "~/env";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { getRedis, redisKey } from "~/server/redis";
import {
  FIRST_SENDS_REVIEW,
  isFirstSendsReviewRequired,
  SCREENING_POLICY,
  type FirstSendsReviewPolicy,
} from "~/lib/constants/sending-policy";
import {
  describeFindings,
  type ScreeningVerdict,
} from "~/server/screening/content-rules";
import { ContentScreeningService } from "./content-screening-service";
import { TeamService } from "./team-service";

/**
 * Last stop before an email reaches the shared tenancy. Every send path
 * (API, SMTP proxy, campaigns, scheduled) goes through the queue worker,
 * which asks this gate whether to send, hold for review, or reject.
 */

export type GateDecision = "send" | "held" | "rejected";

export type GateEmail = {
  id: string;
  teamId: number;
  subject: string;
  html: string | null;
  text: string | null;
  campaignId: string | null;
};

export type GateInput = {
  email: GateEmail;
  attachments: Array<{ filename: string }>;
  headers?: Record<string, string>;
  unsubUrl?: string;
  isBulk: boolean;
  now?: Date;
};

export const HELD_MESSAGES: Record<EmailReviewReason, string> = {
  CONTENT:
    "Held for review: our content checks flagged this email. A person reviews it before it is sent.",
  FIRST_SENDS:
    "Held for review: the first emails from new accounts are checked by a person before they are sent.",
};

export function getFirstSendsPolicy(): FirstSendsReviewPolicy {
  return {
    emails: env.FIRST_SENDS_REVIEW_EMAILS ?? FIRST_SENDS_REVIEW.emails,
    hours: env.FIRST_SENDS_REVIEW_HOURS ?? FIRST_SENDS_REVIEW.hours,
  };
}

function hasHeader(headers: Record<string, string> | undefined, name: string) {
  return Object.keys(headers ?? {}).some(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
}

function isMarketingEmail(input: GateInput): boolean {
  if (input.isBulk || input.email.campaignId) return true;
  const precedence = Object.entries(input.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "precedence",
  )?.[1];
  return /^(bulk|list)$/i.test(precedence?.trim() ?? "");
}

/**
 * New teams send through the review queue until they have sent enough mail
 * and are old enough. Graduation is persisted (sendingTrustedAt) so the
 * count query stops once a team is past it. Cloud only.
 */
export async function needsFirstSendsReview(
  teamId: number,
  now: Date,
): Promise<boolean> {
  if (!env.NEXT_PUBLIC_IS_CLOUD) return false;
  const team = await TeamService.getTeamCached(teamId);
  if (team.isVerified || team.sendingTrustedAt) return false;

  const usage = await db.dailyEmailUsage.aggregate({
    where: { teamId },
    _sum: { sent: true },
  });
  const sentCount = usage._sum.sent ?? 0;
  const required = isFirstSendsReviewRequired({
    team,
    sentCount,
    now,
    policy: getFirstSendsPolicy(),
  });

  if (!required) {
    await db.team.updateMany({
      where: { id: teamId, sendingTrustedAt: null },
      data: { sendingTrustedAt: now },
    });
    await TeamService.invalidateTeamCache(teamId);
    logger.info(
      { teamId, sentCount },
      "[SendGate]: Team passed first-sends review",
    );
  }
  return required;
}

function findingsJson(verdict: ScreeningVerdict): Prisma.InputJsonValue {
  return verdict.findings.map((f) => ({
    code: f.code,
    severity: f.severity,
    score: f.score,
    message: f.message,
    ...(f.detail ? { detail: f.detail } : {}),
  }));
}

async function rejectEmail(input: GateInput, verdict: ScreeningVerdict) {
  const { email } = input;
  const error = `Rejected by content screening: ${describeFindings(verdict.findings)}`;
  await db.$transaction([
    db.email.update({
      where: { id: email.id },
      data: { latestStatus: "FAILED" },
    }),
    db.emailEvent.create({
      data: {
        emailId: email.id,
        status: "FAILED",
        data: { error, findings: findingsJson(verdict) },
        teamId: email.teamId,
      },
    }),
  ]);
  if (verdict.strike) {
    await ContentScreeningService.recordStrike(email.teamId, verdict);
  }
}

async function holdEmail(
  input: GateInput,
  reason: EmailReviewReason,
  verdict: ScreeningVerdict,
) {
  const { email } = input;
  const findings = findingsJson(verdict);
  await db.$transaction([
    db.emailReview.upsert({
      where: { emailId: email.id },
      create: {
        emailId: email.id,
        teamId: email.teamId,
        reason,
        score: verdict.score,
        findings,
        unsubUrl: input.unsubUrl,
        isBulk: input.isBulk,
      },
      update: {
        reason,
        status: "PENDING",
        score: verdict.score,
        findings,
        unsubUrl: input.unsubUrl,
        isBulk: input.isBulk,
        decidedAt: null,
        decidedBy: null,
      },
    }),
    db.email.update({
      where: { id: email.id },
      data: { latestStatus: "HELD" },
    }),
    db.emailEvent.create({
      data: {
        emailId: email.id,
        status: "HELD",
        data: {
          reason,
          message: HELD_MESSAGES[reason],
          ...(verdict.findings.length
            ? { checks: describeFindings(verdict.findings) }
            : {}),
        },
        teamId: email.teamId,
      },
    }),
  ]);
  logger.info(
    { emailId: email.id, teamId: email.teamId, reason, score: verdict.score },
    "[SendGate]: Email held for review",
  );
  await notifyAdminOfHeldEmails();
}

/** Emails the admin about the review queue, at most once per cooldown. */
export async function notifyAdminOfHeldEmails(): Promise<void> {
  if (!env.ADMIN_EMAIL) return;
  try {
    const acquired = await getRedis().set(
      redisKey("screening:held-notify"),
      "1",
      "EX",
      SCREENING_POLICY.heldNotifyCooldownMinutes * 60,
      "NX",
    );
    if (acquired !== "OK") return;
    const pending = await db.emailReview.count({
      where: { status: "PENDING" },
    });
    await ContentScreeningService.notifyAdmin(
      `[admin] Scribase Mail: ${pending} email(s) waiting for review`,
      `${pending} email(s) are held for review.\n\n${env.NEXTAUTH_URL}/admin/review`,
    );
  } catch (error) {
    logger.error(
      { err: error },
      "[SendGate]: Failed to notify admin of held emails",
    );
  }
}

export async function gateOutgoingEmail(
  input: GateInput,
): Promise<GateDecision> {
  const now = input.now ?? new Date();
  const verdict = await ContentScreeningService.screen({
    subject: input.email.subject,
    html: input.email.html,
    text: input.email.text,
    attachments: input.attachments,
    isMarketing: isMarketingEmail(input),
    hasListUnsubscribe:
      Boolean(input.unsubUrl) || hasHeader(input.headers, "List-Unsubscribe"),
  });

  if (verdict.action === "reject") {
    await rejectEmail(input, verdict);
    return "rejected";
  }

  const reason: EmailReviewReason | null =
    verdict.action === "hold"
      ? "CONTENT"
      : (await needsFirstSendsReview(input.email.teamId, now))
        ? "FIRST_SENDS"
        : null;

  if (reason) {
    await holdEmail(input, reason, verdict);
    return "held";
  }
  return "send";
}
