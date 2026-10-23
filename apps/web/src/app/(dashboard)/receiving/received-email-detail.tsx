"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { getReviewPreviewSrcDoc } from "~/lib/email-preview";
import Spinner from "@usesend/ui/src/spinner";
import { Button } from "@usesend/ui/src/button";
import { Textarea } from "@usesend/ui/src/textarea";
import { toast } from "@usesend/ui/src/toaster";
import { X, Reply, SendHorizonal } from "lucide-react";
import { formatDate } from "date-fns";

interface Props {
  id: string;
  onClose: () => void;
}

function extractBareAddress(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return (match?.[1] ?? address).trim();
}

function ReplyComposer({
  receivedEmailId,
  fromAddress,
  toAddress,
  onDone,
}: {
  receivedEmailId: string;
  fromAddress: string;
  toAddress: string;
  onDone: () => void;
}) {
  const [body, setBody] = useState("");
  const replyMutation = api.receivedEmail.reply.useMutation();

  function handleSend() {
    if (!body.trim()) return;
    replyMutation.mutate(
      { id: receivedEmailId, from: fromAddress, text: body },
      {
        onSuccess: () => {
          toast.success("Reply sent");
          onDone();
        },
        onError: (err) => {
          toast.error(err.message || "Failed to send reply");
        },
      },
    );
  }

  return (
    <div className="border-t bg-muted/30 p-4 space-y-2">
      <p className="text-xs text-muted-foreground">
        {fromAddress} &rarr; {toAddress}
      </p>
      <Textarea
        autoFocus
        rows={5}
        placeholder="Write a reply…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="icon" onClick={onDone} aria-label="Cancel">
          <X className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          onClick={handleSend}
          disabled={replyMutation.isPending || !body.trim()}
          aria-label="Send reply"
        >
          {replyMutation.isPending ? (
            <Spinner />
          ) : (
            <SendHorizonal className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

export default function ReceivedEmailDetail({ id, onClose }: Props) {
  const { data, isLoading } = api.receivedEmail.get.useQuery({ id });
  const [isReplying, setIsReplying] = useState(false);
  const rawHtml = (data as Record<string, unknown> | undefined)?.html;
  const previewSrcDoc =
    typeof rawHtml === "string" ? getReviewPreviewSrcDoc(rawHtml, null) : null;

  const fromAddress =
    typeof (data as Record<string, unknown> | undefined)?.to === "object"
      ? (((data as Record<string, unknown>).to as string[])[0] ?? "")
      : "";
  const toAddress = data
    ? extractBareAddress((data as Record<string, unknown>).from as string)
    : "";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/30">
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-background shadow-lg flex flex-col">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold text-lg">Received Email</h2>
          <div className="flex items-center gap-1">
            {data ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsReplying((v) => !v)}
                aria-label="Reply"
              >
                <Reply className="h-4 w-4" />
              </Button>
            ) : null}
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !data ? (
          <p className="p-6 text-muted-foreground">Email not found.</p>
        ) : (
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <EmailMetaRow label="From" value={(data as Record<string, unknown>).from as string} />
            <EmailMetaRow label="To" value={((data as Record<string, unknown>).to as string[]).join(", ")} />
            <EmailMetaRow label="Subject" value={(data as Record<string, unknown>).subject as string} />
            <EmailMetaRow
              label="Received"
              value={formatDate(
                new Date((data as Record<string, unknown>).created_at as string),
                "PPpp",
              )}
            />
            <EmailMetaRow label="Size" value={`${(data as Record<string, unknown>).size as number} bytes`} />
            <div className="flex gap-4">
              <EmailMetaRow label="SPF" value={(data as Record<string, unknown>).spf_result as string ?? "—"} />
              <EmailMetaRow label="DKIM" value={(data as Record<string, unknown>).dkim_result as string ?? "—"} />
              <EmailMetaRow label="DMARC" value={(data as Record<string, unknown>).dmarc_result as string ?? "—"} />
            </div>

            {/* Sandboxed HTML preview — no remote loads */}
            {previewSrcDoc ? (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  HTML Preview
                </p>
                <iframe
                  // Untrusted inbound HTML: no scripts, no same-origin, and the
                  // CSP blocks remote loads (tracking pixels, phishing pages).
                  srcDoc={previewSrcDoc}
                  sandbox=""
                  className="w-full rounded border bg-white"
                  style={{ minHeight: "400px" }}
                  title="Email preview"
                />
              </div>
            ) : null}

            {!previewSrcDoc && typeof (data as Record<string, unknown>).text === "string" && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Plain Text
                </p>
                <pre className="whitespace-pre-wrap rounded border p-4 text-sm bg-muted font-mono">
                  {(data as Record<string, unknown>).text as string}
                </pre>
              </div>
            )}

            {/* Attachments */}
            {((data as Record<string, unknown>).attachments as unknown[])?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Attachments
                </p>
                <ul className="space-y-1">
                  {((data as Record<string, unknown>).attachments as Record<string, unknown>[]).map((att) => (
                    <li key={att.id as string} className="flex items-center gap-2 text-sm">
                      <span className="truncate">{att.filename as string}</span>
                      <span className="text-muted-foreground text-xs">
                        ({att.size as number} bytes)
                      </span>
                      {Boolean(att.download_url) && (
                        <a
                          href={att.download_url as string}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary text-xs underline"
                        >
                          Download
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {isReplying && data ? (
          <ReplyComposer
            receivedEmailId={id}
            fromAddress={fromAddress}
            toAddress={toAddress}
            onDone={() => setIsReplying(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

function EmailMetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm break-all">{value}</dd>
    </div>
  );
}
