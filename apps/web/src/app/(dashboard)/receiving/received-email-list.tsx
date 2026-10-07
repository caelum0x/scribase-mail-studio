"use client";

import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@usesend/ui/src/table";
import { api } from "~/trpc/react";
import { formatDistanceToNow } from "date-fns";
import Spinner from "@usesend/ui/src/spinner";
import { useState } from "react";
import ReceivedEmailDetail from "./received-email-detail";

export default function ReceivedEmailList() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isLoading } = api.receivedEmail.list.useQuery({ limit: 50 });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (!data || data.data.length === 0) {
    return (
      <div className="text-muted-foreground py-12 text-center text-sm">
        No received emails yet. Enable receiving on a domain to get started.
      </div>
    );
  }

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>From</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>To</TableHead>
            <TableHead>SPF</TableHead>
            <TableHead>DKIM</TableHead>
            <TableHead>DMARC</TableHead>
            <TableHead>Received</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.data.map((email) => {
            const e = email as Record<string, unknown>;
            return (
              <TableRow
                key={e.id as string}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setSelectedId(e.id as string)}
              >
                <TableCell className="max-w-[180px] truncate font-medium">
                  {e.from as string}
                </TableCell>
                <TableCell className="max-w-[260px] truncate">
                  {e.subject as string}
                </TableCell>
                <TableCell className="max-w-[180px] truncate text-muted-foreground">
                  {((e.to as string[]) ?? []).join(", ")}
                </TableCell>
                <TableCell>
                  <AuthBadge value={e.spf_result as string | null} />
                </TableCell>
                <TableCell>
                  <AuthBadge value={e.dkim_result as string | null} />
                </TableCell>
                <TableCell>
                  <AuthBadge value={e.dmarc_result as string | null} />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                  {formatDistanceToNow(new Date(e.created_at as string), {
                    addSuffix: true,
                  })}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {selectedId && (
        <ReceivedEmailDetail
          id={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function AuthBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground text-xs">—</span>;
  const pass = value === "pass";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
        pass
          ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
          : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
      }`}
    >
      {value}
    </span>
  );
}
