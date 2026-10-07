const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcDateString(d: Date): string {
  return d.toISOString().split("T")[0] as string;
}

/**
 * Yesterday's date (UTC) in YYYY-MM-DD format.
 */
export function getUsageDate(now: Date = new Date()): string {
  return toUtcDateString(new Date(now.getTime() - DAY_MS));
}

/**
 * The last `days` completed UTC days, newest first. The usage job reports a
 * short look-back window so a missed run is caught up; Dodo drops repeated
 * event ids, so re-reporting a day is harmless.
 */
export function getUsageDates(days: number, now: Date = new Date()): string[] {
  return Array.from({ length: days }, (_, i) =>
    toUtcDateString(new Date(now.getTime() - (i + 1) * DAY_MS)),
  );
}
