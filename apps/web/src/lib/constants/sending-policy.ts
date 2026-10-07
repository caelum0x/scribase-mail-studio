/**
 * Abuse controls for a shared sending tenancy.
 *
 * Every customer sends through one OCI Email Delivery tenancy, so one bad
 * sender can get all of them suspended. Two guards keep that risk bounded:
 * - warm-up: new teams get a small daily cap that grows with account age
 * - reputation: teams whose bounce or complaint rate crosses a threshold are
 *   warned, then paused until an admin reviews them
 * - content screening: every outgoing email is checked for malicious links
 *   and spam/phishing signals (allow / hold for review / reject)
 * - first-sends review: a new team's first emails wait for an admin
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * New teams' emails are held for admin review until the team has sent
 * `emails` emails AND is `hours` old (or an admin trusts / verifies it).
 * Both values can be overridden with FIRST_SENDS_REVIEW_EMAILS and
 * FIRST_SENDS_REVIEW_HOURS; set both to 0 to turn the review off.
 */
export const FIRST_SENDS_REVIEW = {
  emails: 20,
  hours: 48,
} as const;

export type FirstSendsReviewPolicy = { emails: number; hours: number };

export type ReviewableTeam = {
  isVerified: boolean;
  sendingTrustedAt: Date | string | null;
  // May come back from the Redis team cache as a string.
  createdAt: Date | string;
};

export function isFirstSendsReviewRequired({
  team,
  sentCount,
  now,
  policy = FIRST_SENDS_REVIEW,
}: {
  team: ReviewableTeam;
  sentCount: number;
  now: Date;
  policy?: FirstSendsReviewPolicy;
}): boolean {
  if (policy.emails <= 0 && policy.hours <= 0) return false;
  if (team.isVerified || team.sendingTrustedAt) return false;

  const ageHours =
    (now.getTime() - new Date(team.createdAt).getTime()) / HOUR_MS;
  return ageHours < policy.hours || sentCount < policy.emails;
}

/**
 * Content screening thresholds. Findings carry a score; hard findings
 * (malicious link, blocked attachment) reject outright and count as a strike.
 */
export const SCREENING_POLICY = {
  // Heuristic score at which an email is held for review.
  holdScore: 5,
  // Heuristic score at which an email is rejected without review.
  rejectScore: 15,
  // Rejections for malicious content within the window that block the team.
  strikesToBlock: 3,
  strikeWindowDays: 7,
  // Admin notifications about new held emails go out at most this often.
  heldNotifyCooldownMinutes: 30,
} as const;

// Ordered by minAgeDays ascending. dailyLimit -1 means no warm-up cap.
export const WARMUP_TIERS: ReadonlyArray<{
  minAgeDays: number;
  dailyLimit: number;
}> = [
  { minAgeDays: 0, dailyLimit: 50 },
  { minAgeDays: 3, dailyLimit: 200 },
  { minAgeDays: 7, dailyLimit: 1000 },
  { minAgeDays: 14, dailyLimit: 5000 },
  { minAgeDays: 30, dailyLimit: -1 },
];

export function getWarmupDailyLimit(teamCreatedAt: Date, now: Date): number {
  const ageDays = Math.max(
    0,
    (now.getTime() - teamCreatedAt.getTime()) / DAY_MS,
  );
  const tier = [...WARMUP_TIERS]
    .reverse()
    .find((t) => ageDays >= t.minAgeDays);
  return tier?.dailyLimit ?? WARMUP_TIERS[0]!.dailyLimit;
}

// Rates are fractions (0.04 = 4%). Thresholds follow common ESP practice.
export const REPUTATION_POLICY = {
  windowDays: 7,
  minSent: 100,
  bounce: { warn: 0.02, pause: 0.04 },
  complaint: { warn: 0.0005, pause: 0.001 },
  // A single complaint on a small sample is noise; pause needs at least this many.
  minComplaintsToPause: 2,
} as const;

export type ReputationStatus = "ok" | "warning" | "paused";
export type ReputationReason = "BOUNCE_RATE" | "COMPLAINT_RATE";

export type ReputationStats = {
  sent: number;
  hardBounced: number;
  complained: number;
};

export type ReputationResult = {
  status: ReputationStatus;
  reason?: ReputationReason;
  bounceRate: number;
  complaintRate: number;
};

const SEVERITY: Record<ReputationStatus, number> = {
  ok: 0,
  warning: 1,
  paused: 2,
};

export function evaluateReputation(stats: ReputationStats): ReputationResult {
  const bounceRate = stats.sent ? stats.hardBounced / stats.sent : 0;
  const complaintRate = stats.sent ? stats.complained / stats.sent : 0;
  const rates = { bounceRate, complaintRate };

  if (stats.sent < REPUTATION_POLICY.minSent) {
    return { status: "ok", ...rates };
  }

  const bounceStatus: ReputationStatus =
    bounceRate >= REPUTATION_POLICY.bounce.pause
      ? "paused"
      : bounceRate >= REPUTATION_POLICY.bounce.warn
        ? "warning"
        : "ok";

  const complaintStatus: ReputationStatus =
    complaintRate >= REPUTATION_POLICY.complaint.pause &&
    stats.complained >= REPUTATION_POLICY.minComplaintsToPause
      ? "paused"
      : complaintRate >= REPUTATION_POLICY.complaint.warn
        ? "warning"
        : "ok";

  if (bounceStatus === "ok" && complaintStatus === "ok") {
    return { status: "ok", ...rates };
  }

  // Complaints hurt the shared tenancy more, so they win ties.
  return SEVERITY[complaintStatus] >= SEVERITY[bounceStatus]
    ? { status: complaintStatus, reason: "COMPLAINT_RATE", ...rates }
    : { status: bounceStatus, reason: "BOUNCE_RATE", ...rates };
}
