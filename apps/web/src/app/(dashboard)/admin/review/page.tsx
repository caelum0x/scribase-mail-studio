"use client";

import { useState } from "react";
import { Button } from "@usesend/ui/src/button";
import { Badge } from "@usesend/ui/src/badge";
import Spinner from "@usesend/ui/src/spinner";
import { Textarea } from "@usesend/ui/src/textarea";
import { toast } from "@usesend/ui/src/toaster";
import { formatDistanceToNow } from "date-fns";

import { api } from "~/trpc/react";
import { getReviewPreviewSrcDoc } from "~/lib/email-preview";
import type { AppRouter } from "~/server/api/root";
import type { inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type HeldItem = RouterOutputs["adminReview"]["list"]["items"][number];

type Finding = {
  code: string;
  severity: "reject" | "hold" | "score";
  score: number;
  message: string;
  detail?: string;
};

function findingsOf(item: HeldItem): Finding[] {
  return Array.isArray(item.findings) ? (item.findings as Finding[]) : [];
}

function recipients(item: HeldItem): string {
  const all = [...item.email.to, ...item.email.cc, ...item.email.bcc];
  return all.length > 1 ? `${all[0]} +${all.length - 1}` : (all[0] ?? "");
}

export default function AdminReviewPage() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const utils = api.useUtils();
  const list = api.adminReview.list.useQuery({ cursor });
  const feed = api.adminReview.feedStatus.useQuery();
  const preview = api.adminReview.preview.useQuery(
    { reviewId: selectedId ?? "" },
    { enabled: Boolean(selectedId) },
  );

  const onDone = async (message: string) => {
    toast.success(message);
    setSelectedId(null);
    setNote("");
    await utils.adminReview.list.invalidate();
  };
  const onError = (error: { message?: string }) =>
    toast.error(error.message ?? "Action failed");

  const approve = api.adminReview.approve.useMutation({
    onSuccess: (r) => onDone(`Approved ${r.approved}, failed ${r.failed}`),
    onError,
  });
  const approveTeam = api.adminReview.approveTeam.useMutation({
    onSuccess: (r) => onDone(`Approved ${r.approved} email(s) from the team`),
    onError,
  });
  const reject = api.adminReview.reject.useMutation({
    onSuccess: (r) =>
      onDone(
        r.blockedTeams.length
          ? `Rejected ${r.rejected}, blocked team ${r.blockedTeams.join(", ")}`
          : `Rejected ${r.rejected}`,
      ),
    onError,
  });

  const busy = approve.isPending || approveTeam.isPending || reject.isPending;
  const items = list.data?.items ?? [];
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const srcDoc = preview.data
    ? getReviewPreviewSrcDoc(preview.data.email.html, preview.data.email.text)
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <h2 className="text-base font-semibold">Review queue</h2>
        <Badge variant="outline">{list.data?.pendingTotal ?? 0} waiting</Badge>
        <span className="text-muted-foreground">
          {feed.data
            ? `Threat feed: ${feed.data.hosts.toLocaleString()} hosts, updated ${formatDistanceToNow(new Date(feed.data.updatedAt), { addSuffix: true })}`
            : "Threat feed: not loaded yet"}
        </span>
      </div>

      {list.isLoading ? (
        <Spinner className="h-5 w-5" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing is waiting for review.
        </p>
      ) : (
        <div className="divide-y rounded-xl border">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              className={`flex w-full flex-col gap-1 p-3 text-left text-sm hover:bg-muted/40 ${
                item.id === selectedId ? "bg-muted/50" : ""
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    item.reason === "CONTENT" ? "destructive" : "outline"
                  }
                >
                  {item.reason === "CONTENT" ? "Content" : "First sends"}
                </Badge>
                <span className="font-medium">{item.email.subject}</span>
                <span className="text-muted-foreground">
                  {formatDistanceToNow(new Date(item.createdAt), {
                    addSuffix: true,
                  })}
                </span>
              </div>
              <div className="text-muted-foreground">
                Team #{item.teamId} {item.team.name} (created{" "}
                {formatDistanceToNow(new Date(item.team.createdAt), {
                  addSuffix: true,
                })}
                ) · {item.email.from} → {recipients(item)}
                {item.email.campaignId ? " · campaign" : ""}
              </div>
              {findingsOf(item).length > 0 ? (
                <div className="text-xs text-muted-foreground">
                  {findingsOf(item)
                    .map((f) => f.message)
                    .join(" · ")}
                </div>
              ) : null}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!cursor}
          onClick={() => setCursor(undefined)}
        >
          First page
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!list.data?.nextCursor}
          onClick={() => setCursor(list.data?.nextCursor)}
        >
          Next page
        </Button>
      </div>

      {selected ? (
        <div className="flex flex-col gap-4 rounded-xl border p-4">
          <div className="flex flex-col gap-1 text-sm">
            <div className="font-semibold">{selected.email.subject}</div>
            <div>From: {selected.email.from}</div>
            <div>
              To:{" "}
              {[
                ...selected.email.to,
                ...selected.email.cc,
                ...selected.email.bcc,
              ].join(", ")}
            </div>
            {preview.data?.email.attachments.length ? (
              <div>
                Attachments: {preview.data.email.attachments.join(", ")}
              </div>
            ) : null}
            <div>Score: {selected.score}</div>
          </div>

          {findingsOf(selected).length > 0 ? (
            <ul className="list-disc pl-5 text-sm">
              {findingsOf(selected).map((f) => (
                <li key={`${f.code}-${f.detail ?? ""}`}>
                  <span className="font-mono text-xs">{f.code}</span>{" "}
                  {f.message}
                  {f.detail ? ` (${f.detail})` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No content flags. Held because the team is new.
            </p>
          )}

          <div className="h-[420px] overflow-hidden rounded border bg-white">
            {preview.isLoading ? (
              <Spinner className="m-4 h-5 w-5" />
            ) : srcDoc ? (
              // sandbox="" disables scripts, forms and same-origin access;
              // the CSP in srcDoc blocks every remote load.
              <iframe className="h-full w-full" srcDoc={srcDoc} sandbox="" />
            ) : (
              <p className="p-4 text-sm text-slate-500">No content</p>
            )}
          </div>

          <Textarea
            placeholder="Note for the customer (optional, shown on reject)"
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => approve.mutate({ reviewIds: [selected.id] })}
            >
              Approve
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                approve.mutate({ reviewIds: [selected.id], trustTeam: true })
              }
            >
              Approve and trust team
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                approveTeam.mutate({
                  teamId: selected.teamId,
                  trustTeam: false,
                })
              }
            >
              Approve all from this team
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                reject.mutate({
                  reviewIds: [selected.id],
                  note: note || undefined,
                })
              }
            >
              Reject
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Block team #${selected.teamId} and reject all of its held emails?`,
                  )
                ) {
                  reject.mutate({
                    reviewIds: [selected.id],
                    blockTeam: true,
                    note: note || undefined,
                  });
                }
              }}
            >
              Reject and block team
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
