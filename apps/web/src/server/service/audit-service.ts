/**
 * AuditService – records security-relevant actions into the AuditLog table.
 *
 * A thin, fire-and-forget wrapper so that tRPC routers and public-API handlers
 * can log actions without blocking the primary response. All audit records are
 * soft-immutable (no update/delete on AuditLog rows).
 */
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";

/** Mirror of the Prisma-generated AuditActorType enum. Use literals until client is regenerated. */
export const AuditActorType = {
  USER: "USER",
  API_KEY: "API_KEY",
  SYSTEM: "SYSTEM",
} as const;
export type AuditActorTypeValue = (typeof AuditActorType)[keyof typeof AuditActorType];

// How long audit logs are kept before the cleanup job removes them.
// Default: 90 days (configurable via AUDIT_LOG_RETENTION_DAYS).
export const AUDIT_LOG_RETENTION_DAYS = (() => {
  const v = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS ?? "90", 10);
  return isNaN(v) || v <= 0 ? 90 : v;
})();

export type AuditContext = {
  teamId: number;
  actorType: AuditActorTypeValue;
  actorUserId?: number | null;
  actorApiKeyId?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Dot-separated action names, e.g. "api_key.created". */
export const AuditAction = {
  // Auth
  SIGN_IN: "auth.sign_in",
  SIGN_OUT: "auth.sign_out",
  // MFA
  MFA_ENROLLED: "mfa.enrolled",
  MFA_DISABLED: "mfa.disabled",
  MFA_ADMIN_RESET: "mfa.admin_reset",
  MFA_CHALLENGE_PASSED: "mfa.challenge_passed",
  MFA_RECOVERY_USED: "mfa.recovery_used",
  // API keys
  API_KEY_CREATED: "api_key.created",
  API_KEY_DELETED: "api_key.deleted",
  API_KEY_UPDATED: "api_key.updated",
  // Domains
  DOMAIN_ADDED: "domain.added",
  DOMAIN_DELETED: "domain.deleted",
  DOMAIN_VERIFIED: "domain.verified",
  // Webhooks
  WEBHOOK_CREATED: "webhook.created",
  WEBHOOK_UPDATED: "webhook.updated",
  WEBHOOK_DELETED: "webhook.deleted",
  WEBHOOK_SECRET_ROTATED: "webhook.secret_rotated",
  // Team / members
  MEMBER_INVITED: "team.member_invited",
  MEMBER_REMOVED: "team.member_removed",
  MEMBER_ROLE_CHANGED: "team.member_role_changed",
  TEAM_SETTING_UPDATED: "team.setting_updated",
  REQUIRE_2FA_CHANGED: "team.require_2fa_changed",
  SENDING_POOL_CHANGED: "team.sending_pool_changed",
  // Billing
  BILLING_PLAN_CHANGED: "billing.plan_changed",
  // Admin
  ADMIN_BLOCK: "admin.block",
  ADMIN_UNBLOCK: "admin.unblock",
  ADMIN_REVIEW_APPROVED: "admin.review_approved",
  ADMIN_REVIEW_REJECTED: "admin.review_rejected",
} as const;

export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];

export interface RecordOptions {
  targetType?: string;
  targetId?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Record an audit event. Failures are logged but never thrown — audit
 * recording must not block the primary operation.
 */
export async function recordAudit(
  ctx: AuditContext,
  action: AuditActionType,
  opts: RecordOptions = {},
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        teamId: ctx.teamId,
        actorType: ctx.actorType,
        actorUserId: ctx.actorUserId ?? null,
        actorApiKeyId: ctx.actorApiKeyId ?? null,
        action,
        targetType: opts.targetType ?? null,
        targetId: opts.targetId !== undefined ? String(opts.targetId) : null,
        metadata: opts.metadata ?? null,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, action, teamId: ctx.teamId }, "[AuditService] failed to record audit log");
  }
}

/** Convenience: build a USER actor context from tRPC ctx. */
export function userAuditCtx(
  teamId: number,
  userId: number,
  opts?: { ip?: string | null; ua?: string | null },
): AuditContext {
  return {
    teamId,
    actorType: AuditActorType.USER,
    actorUserId: userId,
    ipAddress: opts?.ip ?? null,
    userAgent: opts?.ua ?? null,
  };
}

/** Convenience: build an API_KEY actor context (public-API use). */
export function apiKeyAuditCtx(
  teamId: number,
  apiKeyId: number,
  opts?: { ip?: string | null; ua?: string | null },
): AuditContext {
  return {
    teamId,
    actorType: AuditActorType.API_KEY,
    actorApiKeyId: apiKeyId,
    ipAddress: opts?.ip ?? null,
    userAgent: opts?.ua ?? null,
  };
}
