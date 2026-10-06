"use client";

import { Badge } from "@usesend/ui/src/badge";
import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";
import { TextWithCopyButton } from "@usesend/ui/src/text-with-copy";
import { RefreshCw } from "lucide-react";
import { api } from "~/trpc/react";

function StatusBadge({ value }: { value: boolean | null }) {
  if (value === null) {
    return <Badge variant="outline">Not configured</Badge>;
  }
  return value ? (
    <Badge variant="outline" className="border-foreground/40">
      Connected
    </Badge>
  ) : (
    <Badge variant="destructive">Unreachable</Badge>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="text-sm text-right">{children}</div>
    </div>
  );
}

export default function ProviderStatusCard() {
  const statusQuery = api.admin.getProviderStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const status = statusQuery.data;

  return (
    <div className="rounded-xl border bg-background/60 p-6 shadow-sm backdrop-blur">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">Oracle Cloud Email Delivery</h3>
          <p className="text-sm text-muted-foreground">
            {status ? `Region ${status.region}` : "Checking connection"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => statusQuery.refetch()}
          disabled={statusQuery.isFetching}
          aria-label="Refresh provider status"
        >
          {statusQuery.isFetching ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </div>

      {statusQuery.isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Spinner className="h-6 w-6" innerSvgClass="stroke-primary" />
        </div>
      ) : status ? (
        <div className="mt-4 divide-y">
          <Row label="SMTP relay">
            <StatusBadge value={status.smtpReachable} />
          </Row>
          <Row label="SMTP host">
            {status.smtpHost
              ? `${status.smtpHost}:${status.smtpPort ?? ""}`
              : "Not set"}
          </Row>
          <Row label="Email Delivery API">
            <StatusBadge value={status.apiReachable} />
          </Row>
          {status.smtpSubmitEndpoint ? (
            <Row label="Submit endpoint">{status.smtpSubmitEndpoint}</Row>
          ) : null}
          <Row label="SPF record for sending domains">
            <TextWithCopyButton value={status.spfRecord} />
          </Row>
          <Row label="Bounces and complaints">Suppression list polling</Row>
          {status.errors.length > 0 ? (
            <div className="py-3">
              <ul className="space-y-1 text-sm text-destructive">
                {status.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-sm text-destructive">
          Could not load provider status.
        </p>
      )}
    </div>
  );
}
