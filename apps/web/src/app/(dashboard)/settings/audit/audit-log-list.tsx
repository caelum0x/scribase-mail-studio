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
import { Label } from "@usesend/ui/src/label";
import { Button } from "@usesend/ui/src/button";
import { Badge } from "@usesend/ui/src/badge";
import Spinner from "@usesend/ui/src/spinner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@usesend/ui/src/sheet";
import { CodeDisplay } from "~/components/code-display";

const ACTOR_TYPE_LABEL: Record<string, string> = {
  USER: "User",
  API_KEY: "API key",
  SYSTEM: "System",
};

function actionCategory(action: string): string {
  return action.split(".")[0] ?? action;
}

export default function AuditLogList() {
  const [actionPrefix, setActionPrefix] = useState<string>("All actions");
  const [actorUserId, setActorUserId] = useState<string>("Anyone");
  const [targetType, setTargetType] = useState<string>("");
  const [after, setAfter] = useState<string>("");
  const [before, setBefore] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: actionTypes } = api.audit.listActionTypes.useQuery();
  const { data: teamUsers } = api.team.getTeamUsers.useQuery();

  const categories = Array.from(
    new Set((actionTypes ?? []).map(actionCategory)),
  ).sort();

  const logsQuery = api.audit.list.useInfiniteQuery(
    {
      limit: 50,
      actionPrefix:
        actionPrefix === "All actions" ? undefined : actionPrefix,
      actorUserId:
        actorUserId === "Anyone" ? undefined : Number(actorUserId),
      targetType: targetType || undefined,
      after: after ? new Date(after).toISOString() : undefined,
      before: before ? new Date(`${before}T23:59:59`).toISOString() : undefined,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    },
  );

  const rows = logsQuery.data?.pages.flatMap((p) => p.data) ?? [];
  const retentionDays = logsQuery.data?.pages[0]?.retentionDays;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Action</Label>
          <Select
            value={actionPrefix}
            onValueChange={(v) => setActionPrefix(v)}
          >
            <SelectTrigger className="w-[180px] capitalize">
              {actionPrefix}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All actions">All actions</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c} className="capitalize">
                  {c.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Actor</Label>
          <Select value={actorUserId} onValueChange={(v) => setActorUserId(v)}>
            <SelectTrigger className="w-[180px]">
              {actorUserId === "Anyone"
                ? "Anyone"
                : teamUsers?.find((t) => t.userId === Number(actorUserId))
                    ?.user?.name ??
                  teamUsers?.find((t) => t.userId === Number(actorUserId))
                    ?.user?.email}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Anyone">Anyone</SelectItem>
              {teamUsers?.map((tu) => (
                <SelectItem key={tu.userId} value={tu.userId.toString()}>
                  {tu.user?.name || tu.user?.email || `User ${tu.userId}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">
            Target type
          </Label>
          <Input
            placeholder="e.g. domain, webhook"
            className="w-[160px]"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">From</Label>
          <Input
            type="date"
            className="w-[150px]"
            value={after}
            onChange={(e) => setAfter(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">To</Label>
          <Input
            type="date"
            className="w-[150px]"
            value={before}
            onChange={(e) => setBefore(e.target.value)}
          />
        </div>
        {(actionPrefix !== "All actions" ||
          actorUserId !== "Anyone" ||
          targetType ||
          after ||
          before) && (
          <Button
            variant="ghost"
            onClick={() => {
              setActionPrefix("All actions");
              setActorUserId("Anyone");
              setTargetType("");
              setAfter("");
              setBefore("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <div className="border rounded-xl shadow mt-6">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="rounded-tl-xl">Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead className="rounded-tr-xl">IP address</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logsQuery.isLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={5} className="text-center py-4">
                  <Spinner
                    className="w-6 h-6 mx-auto"
                    innerSvgClass="stroke-primary"
                  />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow className="h-32">
                <TableCell colSpan={5} className="text-center py-4">
                  No audit events match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedId(row.id)}
                >
                  <TableCell
                    className="text-sm text-muted-foreground whitespace-nowrap"
                    title={formatDate(row.createdAt, "PPpp")}
                  >
                    {formatDistanceToNow(row.createdAt, { addSuffix: true })}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        {ACTOR_TYPE_LABEL[row.actorType] ?? row.actorType}
                      </Badge>
                      <span className="text-sm">{row.actorName}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.action}
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.targetType
                      ? `${row.targetType}${row.targetId ? ` · ${row.targetId}` : ""}`
                      : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.ipAddress ?? "—"}
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

      {retentionDays ? (
        <p className="text-xs text-muted-foreground mt-3">
          Older entries roll off automatically after {retentionDays} days.
        </p>
      ) : null}

      <Sheet
        open={!!selectedId}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent className="sm:max-w-[520px] w-full overflow-y-auto">
          {selectedId
            ? (() => {
                const row = rows.find((r) => r.id === selectedId);
                if (!row) return null;
                return (
                  <div className="flex flex-col gap-6 mt-4">
                    <SheetHeader>
                      <SheetTitle className="font-mono text-base break-all">
                        {row.action}
                      </SheetTitle>
                    </SheetHeader>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <div className="text-muted-foreground text-xs">
                          Actor
                        </div>
                        <div>{row.actorName}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-xs">
                          Actor type
                        </div>
                        <div>
                          {ACTOR_TYPE_LABEL[row.actorType] ?? row.actorType}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-xs">
                          Target
                        </div>
                        <div>
                          {row.targetType
                            ? `${row.targetType}${row.targetId ? ` · ${row.targetId}` : ""}`
                            : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-xs">
                          IP address
                        </div>
                        <div className="font-mono">
                          {row.ipAddress ?? "—"}
                        </div>
                      </div>
                      <div className="col-span-2">
                        <div className="text-muted-foreground text-xs">
                          Timestamp
                        </div>
                        <div>{formatDate(row.createdAt, "PPpp")}</div>
                      </div>
                      <div className="col-span-2">
                        <div className="text-muted-foreground text-xs">
                          User agent
                        </div>
                        <div className="font-mono text-xs break-all">
                          {row.userAgent ?? "—"}
                        </div>
                      </div>
                    </div>
                    {row.metadata ? (
                      <div className="flex flex-col gap-2">
                        <h4 className="font-medium text-sm">Metadata</h4>
                        <CodeDisplay
                          code={JSON.stringify(row.metadata, null, 2)}
                          language="json"
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })()
            : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
