import { resolveMx as dnsResolveMx } from "node:dns/promises";

import { env } from "~/env";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { sendMail } from "~/server/mailer";
import { getRedis, redisKey } from "~/server/redis";
import {
  AuditAction,
  AuditActorType,
  recordAudit,
} from "~/server/service/audit-service";
import {
  screenSignupEmail,
  type ResolveMx,
  type ScreeningReason,
} from "~/server/service/signup-screening";

/**
 * Hosted (cloud) waitlist auto-approval.
 *
 * A waitlisted user is let in automatically when their account email is on a
 * business domain (not free, not disposable) with a usable MX, the domain has
 * no other active account yet, and today's auto-approval cap is not reached.
 * Anything else, including errors, keeps them on the waitlist for manual
 * review. Approval only flips `User.isWaitlisted`; new teams still start in
 * warm-up with every sending cap, review and reputation guard in place.
 */

export type AutoApproveReason =
  | ScreeningReason
  | "disabled"
  | "not_cloud"
  | "domain_taken"
  | "daily_cap"
  | "error";

export type AutoApproveDecision = {
  approved: boolean;
  reason: AutoApproveReason;
  domain?: string;
};

export type AutoApproveDeps = {
  enabled: boolean;
  isCloud: boolean;
  dailyCap: number;
  resolveMx: ResolveMx;
  /** Other users on this domain that are already off the waitlist. */
  countActiveUsersOnDomain: (domain: string, excludeUserId: number) => Promise<number>;
  /** Atomically reserve one daily slot; returns false when the cap is reached. */
  reserveDailySlot: (cap: number) => Promise<boolean>;
  releaseDailySlot: () => Promise<void>;
  /** Atomically claim the domain; returns false when another sign-up holds it. */
  claimDomain: (domain: string, userId: number) => Promise<boolean>;
  releaseDomain: (domain: string, userId: number) => Promise<void>;
};

/** Pure decision logic (all I/O injected). Fails closed. */
export async function decideAutoApproval(
  user: { id: number; email: string | null | undefined },
  deps: AutoApproveDeps,
): Promise<AutoApproveDecision> {
  if (!deps.enabled) return { approved: false, reason: "disabled" };
  if (!deps.isCloud) return { approved: false, reason: "not_cloud" };

  const screening = await screenSignupEmail(user.email, {
    resolveMx: deps.resolveMx,
  });
  if (!screening.ok) {
    return { approved: false, reason: screening.reason, domain: screening.domain };
  }
  const domain = screening.domain!;

  if ((await deps.countActiveUsersOnDomain(domain, user.id)) > 0) {
    return { approved: false, reason: "domain_taken", domain };
  }
  if (!(await deps.claimDomain(domain, user.id))) {
    return { approved: false, reason: "domain_taken", domain };
  }
  if (!(await deps.reserveDailySlot(deps.dailyCap))) {
    await deps.releaseDomain(domain, user.id);
    return { approved: false, reason: "daily_cap", domain };
  }
  return { approved: true, reason: "ok", domain };
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const DAY_SECONDS = 60 * 60 * 24;

function liveDeps(): AutoApproveDeps {
  const redis = getRedis();
  const dayKey = () => redisKey(`waitlist:auto-approve:day:${utcDay()}`);
  const domainKey = (d: string) => redisKey(`waitlist:auto-approve:domain:${d}`);

  return {
    enabled: env.AUTO_APPROVE_WAITLIST,
    isCloud: env.NEXT_PUBLIC_IS_CLOUD,
    dailyCap: env.AUTO_APPROVE_DAILY_CAP,
    resolveMx: (domain) => dnsResolveMx(domain),
    countActiveUsersOnDomain: (domain, excludeUserId) =>
      db.user.count({
        where: {
          id: { not: excludeUserId },
          isWaitlisted: false,
          email: { endsWith: `@${domain}`, mode: "insensitive" },
        },
      }),
    reserveDailySlot: async (cap) => {
      if (cap <= 0) return false;
      const key = dayKey();
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, DAY_SECONDS * 2);
      if (n > cap) {
        await redis.decr(key);
        return false;
      }
      return true;
    },
    releaseDailySlot: async () => {
      await redis.decr(dayKey());
    },
    claimDomain: async (domain, userId) => {
      const res = await redis.set(domainKey(domain), String(userId), "EX", DAY_SECONDS * 30, "NX");
      if (res === "OK") return true;
      // Idempotent for the same user (e.g. sign-up then waitlist form).
      return (await redis.get(domainKey(domain))) === String(userId);
    },
    releaseDomain: async (domain, userId) => {
      if ((await redis.get(domainKey(domain))) === String(userId)) {
        await redis.del(domainKey(domain));
      }
    },
  };
}

async function adminTeamId(): Promise<number | null> {
  if (!env.ADMIN_EMAIL) return null;
  const admin = await db.user.findUnique({
    where: { email: env.ADMIN_EMAIL },
    select: { teamUsers: { select: { teamId: true }, take: 1, orderBy: { teamId: "asc" } } },
  });
  return admin?.teamUsers[0]?.teamId ?? null;
}

async function notifyAdmin(email: string, domain: string, source: string) {
  const to = env.FOUNDER_EMAIL ?? env.ADMIN_EMAIL;
  if (!to) return;
  const text = `Auto-approved off the waitlist (${source}):\n\nEmail: ${email}\nDomain: ${domain}\n\nChecks passed: business domain, not disposable, MX present, first account on the domain, under the daily cap. The account starts in warm-up with the normal sending caps and review queue. To revoke, move the user back to the waitlist in Admin > Waitlist (this also blocks their teams).`;
  try {
    await sendMail(to, `Scribase Mail: auto-approved ${email}`, text, `<pre style="white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`);
  } catch (err) {
    logger.error({ err, email }, "[AutoApprove] failed to notify admin");
  }
}

/**
 * Try to move a waitlisted user off the waitlist. Returns the decision; never
 * throws (errors keep the user waitlisted).
 */
export async function tryAutoApproveUser(
  user: { id: number; email: string | null | undefined },
  source: "signup" | "waitlist_form",
  deps: AutoApproveDeps = liveDeps(),
): Promise<AutoApproveDecision> {
  let decision: AutoApproveDecision;
  try {
    decision = await decideAutoApproval(user, deps);
  } catch (err) {
    logger.error({ err, userId: user.id }, "[AutoApprove] decision failed; keeping user waitlisted");
    return { approved: false, reason: "error" };
  }

  logger.info(
    { userId: user.id, source, approved: decision.approved, reason: decision.reason, domain: decision.domain },
    "[AutoApprove] waitlist decision",
  );
  if (!decision.approved) return decision;

  try {
    await db.user.update({ where: { id: user.id }, data: { isWaitlisted: false } });
  } catch (err) {
    logger.error({ err, userId: user.id }, "[AutoApprove] failed to update user; keeping user waitlisted");
    await deps.releaseDailySlot().catch(() => undefined);
    await deps.releaseDomain(decision.domain!, user.id).catch(() => undefined);
    return { approved: false, reason: "error", domain: decision.domain };
  }

  const teamId = await adminTeamId().catch(() => null);
  if (teamId !== null) {
    await recordAudit(
      { teamId, actorType: AuditActorType.SYSTEM },
      AuditAction.WAITLIST_AUTO_APPROVED,
      { targetType: "user", targetId: user.id, metadata: { email: user.email, domain: decision.domain, source } },
    );
  }
  await notifyAdmin(user.email ?? "unknown", decision.domain!, source);
  return decision;
}
