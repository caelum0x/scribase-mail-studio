"use client";

import { useState } from "react";
import { formatDate, formatDistanceToNow } from "date-fns";
import { api } from "~/trpc/react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@usesend/ui/src/select";
import { Input } from "@usesend/ui/src/input";
import { Button } from "@usesend/ui/src/button";
import { Badge } from "@usesend/ui/src/badge";
import Spinner from "@usesend/ui/src/spinner";
import { useDebouncedCallback } from "use-debounce";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@usesend/ui/src/sheet";
import { CodeDisplay } from "~/components/code-display";

type Outcome = "all" | "success" | "error";

function StatusBadge({ status }: { status: number }) {
  const variant =
    status >= 500
      ? "destructive"
      : status >= 400
        ? "destructive"
        : status >= 300
          ? "secondary"
          : "outline";
  return (
    <Badge variant={variant} className="font-mono">
      {status}
    </Badge>
  );
}

export default function ApiLogList() {
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [method, setMethod] = useState<string>("All methods");
  const [apiKeyId, setApiKeyId] = useState<string>("All API keys");
  const [pathSearch, setPathSearch] = useState("");
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);

  const debouncedSetPathSearch = useDebouncedCallback((value: string) => {
    setPathSearch(value);
  }, 400);

  const { data: apiKeysQuery } = api.apiKey.getApiKeys.useQuery();

  const logsQuery = api.apiKey.getRequestLogs.useInfiniteQuery(
    {
      outcome,
      method: method === "All methods" ? undefined : method,
      apiKeyId:
        apiKeyId === "All API keys" ? undefined : Number(apiKeyId),
      pathSearch: pathSearch || undefined,
      limit: 30,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    },
  );

  const rows = logsQuery.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="mt-6">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <Input
          placeholder="Search by path, e.g. /emails"
          className="w-full sm:w-[280px]"
          onChange={(e) => debouncedSetPathSearch(e.target.value)}
        />
        <div className="flex flex-col sm:flex-row gap-3">
          <Select
            value={apiKeyId}
            onValueChange={(v) => setApiKeyId(v)}
          >
            <SelectTrigger className="w-full sm:w-[180px]">
              {apiKeyId === "All API keys"
                ? "All API keys"
                : apiKeysQuery?.find((k) => k.id === Number(apiKeyId))?.name}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All API keys">All API keys</SelectItem>
              {apiKeysQuery?.map((k) => (
                <SelectItem key={k.id} value={k.id.toString()}>
                  {k.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={method} onValueChange={(v) => setMethod(v)}>
            <SelectTrigger className="w-full sm:w-[150px]">
              {method}
            </SelectTrigger>
            <SelectContent>
              {["All methods", "GET", "POST", "PATCH", "PUT", "DELETE"].map(
                (m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <Select
            value={outcome}
            onValueChange={(v) => setOutcome(v as Outcome)}
          >
            <SelectTrigger className="w-full sm:w-[150px] capitalize">
              {outcome === "all" ? "All outcomes" : outcome}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All outcomes</SelectItem>
              <SelectItem value="success">Success (2xx/3xx)</SelectItem>
              <SelectItem value="error">Error (4xx/5xx)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border rounded-xl shadow mt-6">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="rounded-tl-xl">Status</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Path</TableHead>
              <TableHead>API key</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead className="rounded-tr-xl">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logsQuery.isLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={6} className="text-center py-4">
                  <Spinner
                    className="w-6 h-6 mx-auto"
                    innerSvgClass="stroke-primary"
                  />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow className="h-32">
                <TableCell colSpan={6} className="text-center py-4">
                  <p>No API requests logged yet for these filters.</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Send a test request with your API key and it will show up
                    here within a few seconds.
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedLogId(row.id)}
                >
                  <TableCell>
                    <StatusBadge status={row.statusCode} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.method}
                  </TableCell>
                  <TableCell className="font-mono text-xs max-w-[280px] truncate">
                    {row.path}
                  </TableCell>
                  <TableCell>{row.apiKeyName ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.durationMs}ms
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    title={formatDate(row.createdAt, "PPpp")}
                  >
                    {formatDistanceToNow(row.createdAt, { addSuffix: true })}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {logsQuery.hasNextPage ? (
        <div className="flex justify-center mt-4">
          <Button
            variant="outline"
            onClick={() => logsQuery.fetchNextPage()}
            disabled={logsQuery.isFetchingNextPage}
          >
            {logsQuery.isFetchingNextPage ? (
              <Spinner className="w-4 h-4" />
            ) : (
              "Load more"
            )}
          </Button>
        </div>
      ) : null}

      <Sheet
        open={!!selectedLogId}
        onOpenChange={(open) => {
          if (!open) setSelectedLogId(null);
        }}
      >
        <SheetContent className="sm:max-w-[560px] w-full overflow-y-auto">
          {selectedLogId ? <ApiLogDetail logId={selectedLogId} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ApiLogDetail({ logId }: { logId: string }) {
  const { data: log, isLoading } = api.apiKey.getRequestLog.useQuery({
    id: logId,
  });

  if (isLoading || !log) {
    return (
      <div className="flex items-center justify-center h-32">
        <Spinner className="w-5 h-5" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 mt-4">
      <SheetHeader>
        <SheetTitle className="font-mono text-base break-all">
          {log.method} {log.path}
        </SheetTitle>
      </SheetHeader>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-muted-foreground text-xs">Status</div>
          <div className="font-mono">{log.statusCode}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Latency</div>
          <div className="font-mono">{log.durationMs}ms</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">API key</div>
          <div>{log.apiKeyName ?? "—"}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">IP address</div>
          <div className="font-mono">{log.ipAddress ?? "—"}</div>
        </div>
        <div className="col-span-2">
          <div className="text-muted-foreground text-xs">Timestamp</div>
          <div>{formatDate(log.createdAt, "PPpp")}</div>
        </div>
        {log.errorName ? (
          <div className="col-span-2">
            <div className="text-muted-foreground text-xs">Error</div>
            <Badge variant="destructive">{log.errorName}</Badge>
          </div>
        ) : null}
        <div className="col-span-2">
          <div className="text-muted-foreground text-xs">User agent</div>
          <div className="font-mono text-xs break-all">
            {log.userAgent ?? "—"}
          </div>
        </div>
      </div>

      {log.requestBody ? (
        <div className="flex flex-col gap-2">
          <h4 className="font-medium text-sm">Request body</h4>
          <CodeDisplay
            code={JSON.stringify(log.requestBody, null, 2)}
            language="json"
          />
        </div>
      ) : null}

      {log.responseBody ? (
        <div className="flex flex-col gap-2">
          <h4 className="font-medium text-sm">Response body</h4>
          <CodeDisplay
            code={JSON.stringify(log.responseBody, null, 2)}
            language="json"
          />
        </div>
      ) : null}
    </div>
  );
}
