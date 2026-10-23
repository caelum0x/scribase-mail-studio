"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { TopicSubscription, TopicVisibility } from "@prisma/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";
import { Badge } from "@usesend/ui/src/badge";
import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import { DeleteResource } from "~/components/DeleteResource";
import { Edit3, Trash2 } from "lucide-react";
import { api } from "~/trpc/react";
import TopicDialog from "./topic-dialog";

export default function TopicList() {
  const topicsQuery = api.topic.list.useQuery();
  const utils = api.useUtils();
  const [editingId, setEditingId] = useState<string | null>(null);

  const deleteMutation = api.topic.delete.useMutation({
    onSuccess: () => {
      utils.topic.list.invalidate();
      toast.success("Topic deleted");
    },
    onError: (error) => toast.error(error.message),
  });

  if (topicsQuery.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="w-6 h-6" />
      </div>
    );
  }

  const topics = topicsQuery.data ?? [];

  if (topics.length === 0) {
    return (
      <div className="border rounded-xl shadow mt-6 py-16 text-center">
        <p className="text-sm text-muted-foreground">
          No topics yet. Create one to let recipients opt out of a specific
          kind of email instead of everything.
        </p>
      </div>
    );
  }

  return (
    <div className="border rounded-xl shadow mt-6">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30">
            <TableHead className="rounded-tl-xl">Name</TableHead>
            <TableHead>Default</TableHead>
            <TableHead>Visibility</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="rounded-tr-xl">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {topics.map((topic) => (
            <TableRow key={topic.id}>
              <TableCell>
                <div className="font-medium">{topic.name}</div>
                {topic.description ? (
                  <div className="text-xs text-muted-foreground max-w-[320px] truncate">
                    {topic.description}
                  </div>
                ) : null}
              </TableCell>
              <TableCell>
                <Badge variant="outline">
                  {topic.defaultSubscription === TopicSubscription.OPT_IN
                    ? "Subscribed"
                    : "Opted out"}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    topic.visibility === TopicVisibility.PUBLIC
                      ? "secondary"
                      : "outline"
                  }
                >
                  {topic.visibility === TopicVisibility.PUBLIC
                    ? "Public"
                    : "Internal"}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDistanceToNow(topic.createdAt, { addSuffix: true })}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingId(topic.id)}
                    aria-label="Edit topic"
                  >
                    <Edit3 className="h-4 w-4" />
                  </Button>
                  <TopicDialog
                    topic={topic}
                    open={editingId === topic.id}
                    onOpenChange={(open) => {
                      if (!open) setEditingId(null);
                    }}
                  />
                  <DeleteResource
                    title="Delete topic"
                    resourceName={topic.name}
                    descriptionBody={`Removes every recipient's preference for "${topic.name}". This can't be undone.`}
                    isLoading={deleteMutation.isPending}
                    onConfirm={() =>
                      deleteMutation.mutate({ topicId: topic.id })
                    }
                    confirmLabel="Delete topic"
                    trigger={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        aria-label="Delete topic"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
