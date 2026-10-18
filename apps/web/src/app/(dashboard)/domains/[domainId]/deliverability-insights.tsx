"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  OctagonAlert,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@usesend/ui/src/badge";
import { Button } from "@usesend/ui/src/button";
import { api } from "~/trpc/react";
import type { InsightSeverity } from "~/server/service/deliverability-insights-service";

interface DeliverabilityInsightsProps {
  domainId: number;
}

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  ok: 3,
};

/**
 * Surfaces the per-domain deliverability health checks (DMARC, SPF, DKIM,
 * return-path, tracking subdomain, bounce/complaint rate over 30 days) that
 * DeliverabilityInsightsService already computes from data already flowing
 * through the system (DNS + DailyEmailUsage). Nothing here invents a new
 * data pipeline -- it just puts an existing, tested backend in front of a
 * human for the first time.
 *
 * Any fetch failure is shown as a visible error banner, never swallowed.
 */
export default function DeliverabilityInsights({
  domainId,
}: DeliverabilityInsightsProps) {
  const insightsQuery = api.domain.getDeliverabilityInsights.useQuery(
    { id: domainId },
    { refetchOnWindowFocus: false },
  );

  return (
    <div className="rounded-lg shadow p-4 border flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold text-xl">Deliverability &amp; sender reputation</p>
          <p className="text-muted-foreground text-sm">
            DMARC, SPF and DKIM health plus your 30-day bounce and complaint
            rate for this domain -- the signals mailbox providers use to
            decide whether your mail reaches the inbox.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => insightsQuery.refetch()}
          disabled={insightsQuery.isFetching}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 mr-2 ${insightsQuery.isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {insightsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Checking deliverability…</p>
      ) : insightsQuery.isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex items-center gap-2">
          <OctagonAlert className="h-4 w-4 shrink-0" />
          Could not load deliverability insights: {insightsQuery.error.message}
        </div>
      ) : insightsQuery.data ? (
        <>
          <div className="flex flex-wrap gap-4">
            <StatTile
              label="Sent (30d)"
              value={insightsQuery.data.stats.sent.toLocaleString()}
            />
            <StatTile
              label="Bounce rate"
              value={`${(insightsQuery.data.stats.bounceRate * 100).toFixed(2)}%`}
            />
            <StatTile
              label="Complaint rate"
              value={`${(insightsQuery.data.stats.complaintRate * 100).toFixed(3)}%`}
            />
          </div>

          <div className="flex flex-col gap-2">
            {[...insightsQuery.data.items]
              .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
              .map((item) => (
                <InsightRow key={item.key} item={item} />
              ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2 min-w-[120px]">
      <p className="text-xs text-muted-foreground font-mono">{label}</p>
      <p className="text-lg font-mono">{value}</p>
    </div>
  );
}

const SEVERITY_ICON: Record<InsightSeverity, typeof CheckCircle2> = {
  ok: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: OctagonAlert,
};

const SEVERITY_BADGE_VARIANT: Record<
  InsightSeverity,
  "outline" | "destructive"
> = {
  ok: "outline",
  info: "outline",
  warning: "destructive",
  error: "destructive",
};

const SEVERITY_TEXT_CLASS: Record<InsightSeverity, string> = {
  ok: "text-success",
  info: "text-muted-foreground",
  warning: "text-warning",
  error: "text-destructive",
};

function InsightRow({
  item,
}: {
  item: {
    key: string;
    label: string;
    severity: InsightSeverity;
    detail: string;
    helpUrl?: string;
  };
}) {
  const Icon = SEVERITY_ICON[item.severity];
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <Icon
        className={`h-4 w-4 mt-0.5 shrink-0 ${SEVERITY_TEXT_CLASS[item.severity]}`}
      />
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm">{item.label}</p>
          <Badge
            variant={SEVERITY_BADGE_VARIANT[item.severity]}
            className="uppercase"
          >
            {item.severity}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{item.detail}</p>
        {item.helpUrl ? (
          <a
            href={item.helpUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary underline"
          >
            Learn more
          </a>
        ) : null}
      </div>
    </div>
  );
}
