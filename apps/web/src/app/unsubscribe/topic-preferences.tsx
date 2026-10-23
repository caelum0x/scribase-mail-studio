"use client";

import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { Switch } from "@usesend/ui/src/switch";
import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";
import { Check } from "lucide-react";

export default function TopicPreferences({
  id,
  hash,
}: {
  id: string;
  hash: string;
}) {
  const { data, isLoading } = api.topic.getPublicPreferences.useQuery({
    id,
    hash,
  });

  const [subscriptions, setSubscriptions] = useState<Record<string, boolean>>(
    {},
  );
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setSubscriptions(
        Object.fromEntries(data.topics.map((t) => [t.id, t.subscribed])),
      );
    }
  }, [data]);

  const updateMutation = api.topic.updatePublicPreferences.useMutation({
    onSuccess: () => setSaved(true),
  });

  if (isLoading || !data || data.topics.length === 0) {
    return null;
  }

  const hasChanges = data.topics.some(
    (t) => subscriptions[t.id] !== t.subscribed,
  );

  return (
    <div className="w-full max-w-md space-y-5 rounded-xl border p-8 shadow">
      <div className="space-y-2">
        <h2 className="text-center text-xl font-semibold">
          Email preferences
        </h2>
        <p className="text-center text-sm text-muted-foreground">
          Choose exactly what you want to hear about at{" "}
          <span className="font-medium text-foreground">{data.email}</span>.
        </p>
      </div>

      <div className="space-y-4">
        {data.topics.map((topic) => (
          <div
            key={topic.id}
            className="flex items-start justify-between gap-4"
          >
            <div>
              <div className="text-sm font-medium">{topic.name}</div>
              {topic.description ? (
                <div className="text-xs text-muted-foreground">
                  {topic.description}
                </div>
              ) : null}
            </div>
            <Switch
              checked={subscriptions[topic.id] ?? topic.subscribed}
              onCheckedChange={(checked) => {
                setSaved(false);
                setSubscriptions((prev) => ({
                  ...prev,
                  [topic.id]: checked,
                }));
              }}
            />
          </div>
        ))}
      </div>

      <Button
        className="w-full"
        disabled={!hasChanges || updateMutation.isPending}
        onClick={() =>
          updateMutation.mutate({
            id,
            hash,
            topics: data.topics.map((t) => ({
              topicId: t.id,
              subscribed: subscriptions[t.id] ?? t.subscribed,
            })),
          })
        }
      >
        {updateMutation.isPending ? (
          <Spinner className="w-4 h-4" />
        ) : saved ? (
          <span className="flex items-center justify-center gap-1.5">
            <Check className="h-4 w-4" />
            Saved
          </span>
        ) : (
          "Save preferences"
        )}
      </Button>
    </div>
  );
}
