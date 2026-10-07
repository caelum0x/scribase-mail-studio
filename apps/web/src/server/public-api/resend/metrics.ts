/**
 * Resend /emails/metrics route (Wave 2 B3).
 *
 * GET /emails/metrics?domain_id=&days=7|30
 *
 * Returns aggregated delivery metrics in a Resend-compatible shape, backed by
 * the existing emailTimeSeries and reputationMetricsData services.
 */
import { db } from "~/server/db";
import {
  emailTimeSeries,
  reputationMetricsData,
} from "~/server/service/dashboard-service";
import type { ResendApp } from "./app";
import { ResendApiError } from "./errors";

export function registerMetricsRoutes(app: ResendApp): void {
  app.get("/emails/metrics", async (c) => {
    const team = c.var.team;
    const query = c.req.query();

    const days = query.days === "30" ? 30 : 7;
    const domainId = query.domain_id
      ? Number(query.domain_id)
      : undefined;

    if (domainId !== undefined && Number.isNaN(domainId)) {
      throw new ResendApiError("validation_error", "Invalid `domain_id` parameter");
    }

    // Verify domain belongs to this team.
    if (domainId !== undefined) {
      const domain = await db.domain.findFirst({
        where: { id: domainId, teamId: team.id },
        select: { id: true },
      });
      if (!domain) {
        throw new ResendApiError("not_found", "Domain not found");
      }
    }

    const [timeSeriesResult, reputationResult] = await Promise.all([
      emailTimeSeries({ days, domain: domainId, team }),
      reputationMetricsData({ domain: domainId, team }),
    ]);

    return c.json(
      {
        object: "email_metrics",
        period_days: days,
        domain_id: domainId ?? null,
        totals: timeSeriesResult.totalCounts,
        reputation: reputationResult,
        time_series: timeSeriesResult.result,
      },
      200,
    );
  });
}
