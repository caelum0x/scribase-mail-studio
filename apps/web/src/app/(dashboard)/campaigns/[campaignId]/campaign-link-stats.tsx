"use client";

import { api } from "~/trpc/react";
import Spinner from "@usesend/ui/src/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";
import { Link2 } from "lucide-react";

export default function CampaignLinkStats({
  campaignId,
}: {
  campaignId: string;
}) {
  const { data, isLoading } = api.campaign.linkStats.useQuery({
    campaignId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner className="w-5 h-5" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
        <Link2 className="w-6 h-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No link clicks recorded yet for this campaign.
        </p>
      </div>
    );
  }

  return (
    <div className="border rounded-xl shadow">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30">
            <TableHead className="rounded-tl-xl">Link</TableHead>
            <TableHead>Total clicks</TableHead>
            <TableHead>Unique clicks</TableHead>
            <TableHead className="rounded-tr-xl">Click rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => (
            <TableRow key={row.url}>
              <TableCell className="max-w-[420px]">
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-xs text-primary hover:underline break-all"
                >
                  {row.url}
                </a>
              </TableCell>
              <TableCell className="font-mono">{row.totalClicks}</TableCell>
              <TableCell className="font-mono">{row.uniqueClicks}</TableCell>
              <TableCell className="font-mono">
                {row.clickRate.toFixed(1)}%
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
