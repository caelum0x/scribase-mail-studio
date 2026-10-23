"use client";

import { useEffect, useState } from "react";
import { TopicSubscription, TopicVisibility } from "@prisma/client";
import { Button } from "@usesend/ui/src/button";
import { Input } from "@usesend/ui/src/input";
import { Label } from "@usesend/ui/src/label";
import { Textarea } from "@usesend/ui/src/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@usesend/ui/src/select";
import { toast } from "@usesend/ui/src/toaster";
import { api } from "~/trpc/react";
import type { ReactNode } from "react";

export type TopicDialogTopic = {
  id: string;
  name: string;
  description: string | null;
  defaultSubscription: TopicSubscription;
  visibility: TopicVisibility;
};

export default function TopicDialog({
  trigger,
  topic,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger?: ReactNode;
  /** When provided, the dialog edits this topic. Otherwise it creates one. */
  topic?: TopicDialogTopic;
  open?: boolean;
  // eslint-disable-next-line no-unused-vars
  onOpenChange?: (open: boolean) => void;
}) {
  const isEdit = !!topic;
  const [open, setOpen] = useState(false);
  const isOpen = controlledOpen ?? open;
  const setIsOpen = onOpenChange ?? setOpen;

  const [name, setName] = useState(topic?.name ?? "");
  const [description, setDescription] = useState(topic?.description ?? "");
  const [defaultSubscription, setDefaultSubscription] = useState<TopicSubscription>(
    topic?.defaultSubscription ?? TopicSubscription.OPT_IN,
  );
  const [visibility, setVisibility] = useState<TopicVisibility>(
    topic?.visibility ?? TopicVisibility.PUBLIC,
  );

  useEffect(() => {
    if (isOpen) {
      setName(topic?.name ?? "");
      setDescription(topic?.description ?? "");
      setDefaultSubscription(topic?.defaultSubscription ?? TopicSubscription.OPT_IN);
      setVisibility(topic?.visibility ?? TopicVisibility.PUBLIC);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const utils = api.useUtils();
  const createMutation = api.topic.create.useMutation();
  const updateMutation = api.topic.update.useMutation();
  const isPending = createMutation.isPending || updateMutation.isPending;

  function handleSave() {
    if (!name.trim()) {
      toast.error("Topic name is required");
      return;
    }

    const onSettled = {
      onSuccess: () => {
        utils.topic.list.invalidate();
        setIsOpen(false);
        toast.success(isEdit ? "Topic updated" : "Topic created");
      },
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
    };

    if (isEdit) {
      updateMutation.mutate(
        {
          topicId: topic.id,
          name,
          description: description || undefined,
          defaultSubscription,
          visibility,
        },
        onSettled,
      );
    } else {
      createMutation.mutate(
        {
          name,
          description: description || undefined,
          defaultSubscription,
          visibility,
        },
        onSettled,
      );
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit topic" : "Create a topic"}</DialogTitle>
          <DialogDescription>
            Topics let recipients opt out of one kind of email (e.g. &quot;Product
            updates&quot;) without unsubscribing from everything.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              placeholder="Product updates"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              placeholder="What recipients see on the preference page"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Default</Label>
              <Select
                value={defaultSubscription}
                onValueChange={(v) =>
                  setDefaultSubscription(v as TopicSubscription)
                }
              >
                <SelectTrigger className="capitalize">
                  {defaultSubscription === TopicSubscription.OPT_IN
                    ? "Subscribed"
                    : "Opted out"}
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TopicSubscription.OPT_IN}>
                    Subscribed by default
                  </SelectItem>
                  <SelectItem value={TopicSubscription.OPT_OUT}>
                    Opted out by default
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Visibility</Label>
              <Select
                value={visibility}
                onValueChange={(v) => setVisibility(v as TopicVisibility)}
              >
                <SelectTrigger className="capitalize">
                  {visibility === TopicVisibility.PUBLIC
                    ? "Shown to recipients"
                    : "Internal only"}
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TopicVisibility.PUBLIC}>
                    Shown to recipients
                  </SelectItem>
                  <SelectItem value={TopicVisibility.PRIVATE}>
                    Internal only
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {visibility === TopicVisibility.PRIVATE ? (
            <p className="text-xs text-muted-foreground">
              Internal topics never appear on the public preference page.
              Use them for API-only segmentation.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : isEdit ? "Save changes" : "Create topic"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
