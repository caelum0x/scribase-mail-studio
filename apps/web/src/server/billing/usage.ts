import { env } from "~/env";
import { getUsageDates } from "~/lib/usage";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { getDodoClient } from "./dodo-client";

/** Dodo accepts at most 1,000 events per ingest request. */
const MAX_EVENTS_PER_REQUEST = 1000;

/** Days re-reported each run so a missed run is caught up. */
export const USAGE_LOOKBACK_DAYS = 3;

export interface TeamDailyUsage {
  teamId: number;
  customerId: string;
  date: string;
  transactional: number;
  marketing: number;
}

export interface UsageEvent {
  event_id: string;
  customer_id: string;
  event_name: string;
  timestamp: string;
  metadata: Record<string, string | number | boolean>;
}

/**
 * One id per team per UTC day. Stable across retries and re-runs, so Dodo
 * ignores repeats and a day is never billed twice.
 */
export function usageEventId(teamId: number, date: string): string {
  return `scribase-mail:usage:${teamId}:${date}`;
}

/**
 * The meter must be a SUM over metadata key "emails" with event name
 * DODO_USAGE_EVENT_NAME. The timestamp is "now" because Dodo only accepts
 * events from the last hour; the day being reported is in usage_date.
 */
export function buildUsageEvent(
  usage: TeamDailyUsage,
  eventName: string,
  now: Date,
): UsageEvent {
  return {
    event_id: usageEventId(usage.teamId, usage.date),
    customer_id: usage.customerId,
    event_name: eventName,
    timestamp: now.toISOString(),
    metadata: {
      emails: usage.transactional + usage.marketing,
      transactional: usage.transactional,
      marketing: usage.marketing,
      usage_date: usage.date,
      team_id: usage.teamId,
    },
  };
}

interface TeamWithUsage {
  id: number;
  billingCustomerId: string | null;
  dailyEmailUsages: { date: string; type: string; sent: number }[];
}

function collectDailyUsage(
  teams: TeamWithUsage[],
  dates: string[],
): TeamDailyUsage[] {
  return teams.flatMap((team) => {
    if (!team.billingCustomerId) return [];
    const customerId = team.billingCustomerId;
    return dates
      .map((date) => {
        const rows = team.dailyEmailUsages.filter((u) => u.date === date);
        const sum = (type: string) =>
          rows.filter((u) => u.type === type).reduce((a, u) => a + u.sent, 0);
        return {
          teamId: team.id,
          customerId,
          date,
          transactional: sum("TRANSACTIONAL"),
          marketing: sum("MARKETING"),
        };
      })
      .filter((u) => u.transactional + u.marketing > 0);
  });
}

export type UsageReportResult =
  | { reported: number }
  | { reported: 0; skipped: "not_configured" };

/**
 * Report recent daily sent-email counts for paid teams to Dodo's meter.
 * Throws on ingest failure so the BullMQ job retries with the same ids.
 */
export async function reportDailyUsage(
  opts: { now?: Date; lookbackDays?: number } = {},
): Promise<UsageReportResult> {
  if (!env.DODO_PAYMENTS_API_KEY || !env.DODO_USAGE_METER_ID) {
    return { reported: 0, skipped: "not_configured" };
  }

  const now = opts.now ?? new Date();
  const dates = getUsageDates(opts.lookbackDays ?? USAGE_LOOKBACK_DAYS, now);

  const teams = await db.team.findMany({
    where: {
      billingCustomerId: { not: null },
      plan: { not: "FREE" },
    },
    select: {
      id: true,
      billingCustomerId: true,
      dailyEmailUsages: {
        where: { date: { in: dates } },
        select: { date: true, type: true, sent: true },
      },
    },
  });

  const events = collectDailyUsage(teams, dates).map((u) =>
    buildUsageEvent(u, env.DODO_USAGE_EVENT_NAME, now),
  );

  const client = getDodoClient();
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_REQUEST) {
    const batch = events.slice(i, i + MAX_EVENTS_PER_REQUEST);
    await client.usageEvents.ingest({ events: batch });
  }

  logger.info(
    { events: events.length, dates },
    "[Usage Reporting]: Reported usage to Dodo",
  );
  return { reported: events.length };
}
