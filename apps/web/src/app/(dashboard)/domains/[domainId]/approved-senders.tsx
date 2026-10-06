"use client";

import { useState } from "react";
import { Button } from "@usesend/ui/src/button";
import { Input } from "@usesend/ui/src/input";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import { api } from "~/trpc/react";

interface ApprovedSendersProps {
  domainId: number;
  domainName: string;
  verified: boolean;
}

export default function ApprovedSenders({
  domainId,
  domainName,
  verified,
}: ApprovedSendersProps) {
  const [localPart, setLocalPart] = useState("");
  const utils = api.useUtils();
  const sendersQuery = api.domain.approvedSenders.useQuery(
    { id: domainId },
    { enabled: verified, refetchOnWindowFocus: false },
  );
  const addSender = api.domain.addApprovedSender.useMutation();

  function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    if (!localPart.trim()) return;
    addSender.mutate(
      { id: domainId, localPart: localPart.trim() },
      {
        onSuccess: ({ email }) => {
          toast.success(`${email} can now send`);
          setLocalPart("");
          utils.domain.approvedSenders.invalidate({ id: domainId });
        },
        onError: (error) => {
          toast.error("Could not add sender", { description: error.message });
        },
      },
    );
  }

  return (
    <div className="rounded-lg shadow p-4 border flex flex-col gap-4">
      <div>
        <p className="font-semibold text-xl">Approved senders</p>
        <p className="text-muted-foreground text-sm">
          Every From address must be approved by the email provider. New
          addresses are approved automatically on their first send; you can also
          add them here ahead of time.
        </p>
      </div>

      {!verified ? (
        <p className="text-sm text-muted-foreground">
          Verify the domain to manage senders.
        </p>
      ) : (
        <>
          <form onSubmit={handleAdd} className="flex items-center gap-2">
            <Input
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              placeholder="hello"
              className="max-w-[200px]"
              aria-label="Sender name"
            />
            <span className="text-sm text-muted-foreground">@{domainName}</span>
            <Button
              type="submit"
              size="sm"
              disabled={addSender.isPending || !localPart.trim()}
            >
              {addSender.isPending ? <Spinner className="h-4 w-4" /> : "Add"}
            </Button>
          </form>

          {sendersQuery.isLoading ? (
            <Spinner className="h-5 w-5" innerSvgClass="stroke-primary" />
          ) : sendersQuery.isError ? (
            <p className="text-sm text-destructive">
              Could not load senders from the provider.
            </p>
          ) : (sendersQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No senders yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {(sendersQuery.data ?? []).map((sender) => (
                <li
                  key={sender.id}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <span>{sender.email}</span>
                  <span className="text-muted-foreground">
                    {sender.state.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
