import { Queue, Worker } from "bullmq";
import { env } from "~/env";
import { logger } from "~/server/logger/log";
import { sendMail } from "~/server/mailer";
import { getRedis, redisKey, BULL_PREFIX } from "~/server/redis";
import {
  DEFAULT_QUEUE_OPTIONS,
  REPUTATION_GUARD_QUEUE,
} from "~/server/queue/queue-constants";
import type { ReputationResult } from "~/lib/constants/sending-policy";
import {
  describeReputation,
  runReputationGuard,
} from "~/server/service/reputation-guard-service";
import { TeamService } from "~/server/service/team-service";

// Sent from FROM_EMAIL; replies go to support.
const NOTIFY_REPLY_TO = "support@scribase.com";
const WARNING_COOLDOWN_SECONDS = 24 * 60 * 60;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Emails the team (and the admin) about a reputation warning or pause.
 * Warnings go out at most once a day per team; pauses always go out because
 * the guard only pauses a team once (blocked teams are skipped afterwards).
 */
export async function notifyReputation(
  teamId: number,
  result: ReputationResult,
): Promise<void> {
  if (result.status === "warning") {
    const acquired = await getRedis().set(
      redisKey(`reputation:warn:${teamId}`),
      "1",
      "EX",
      WARNING_COOLDOWN_SECONDS,
      "NX",
    );
    if (acquired !== "OK") return;
  }

  const team = await TeamService.getTeamCached(teamId);
  const teamUsers = await TeamService.getTeamUsers(teamId);
  const recipients = teamUsers
    .map((tu) => tu.user?.email)
    .filter((e): e is string => Boolean(e));

  const paused = result.status === "paused";
  const detail = describeReputation(result);
  const subject = paused
    ? "Scribase Mail: sending paused for your team"
    : "Scribase Mail: your bounce or complaint rate is high";
  const text = paused
    ? `Hi ${team.name} team,\n\nSending is paused because your rates crossed our limits (${detail}).\n\nClean your recipient lists, remove addresses that bounce, and make sure everyone opted in. Then reply to this email and we will review your account.\n\n${env.NEXTAUTH_URL}/dashboard`
    : `Hi ${team.name} team,\n\nYour rates are close to the level where we pause sending (${detail}).\n\nRemove addresses that bounce and only send to people who opted in.\n\n${env.NEXTAUTH_URL}/dashboard`;
  const html = escapeHtml(text)
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

  await Promise.all(
    recipients.map((to) => sendMail(to, subject, text, html, NOTIFY_REPLY_TO)),
  );

  if (env.ADMIN_EMAIL) {
    await sendMail(
      env.ADMIN_EMAIL,
      `[admin] ${subject}: team ${teamId} (${team.name.replace(/[\r\n]/g, " ")})`,
      `${detail}\n\n${env.NEXTAUTH_URL}/admin/teams`,
      `<p>${escapeHtml(detail)}</p><p>${env.NEXTAUTH_URL}/admin/teams</p>`,
    );
  }
}

let initialized = false;

export async function initReputationGuardJob() {
  if (initialized) {
    return;
  }

  const connection = getRedis();
  const queue = new Queue(REPUTATION_GUARD_QUEUE, {
    connection,
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  });

  const worker = new Worker(
    REPUTATION_GUARD_QUEUE,
    async () => {
      const result = await runReputationGuard({ notify: notifyReputation });
      logger.info({ ...result }, "[ReputationGuardJob]: Run finished");
    },
    {
      connection,
      concurrency: 1,
      prefix: BULL_PREFIX,
      skipVersionCheck: true,
    },
  );

  await queue.upsertJobScheduler(
    "reputation-guard",
    { pattern: env.REPUTATION_GUARD_CRON, tz: "UTC" },
    { opts: { ...DEFAULT_QUEUE_OPTIONS } },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "[ReputationGuardJob]: Job failed");
  });

  initialized = true;
}
