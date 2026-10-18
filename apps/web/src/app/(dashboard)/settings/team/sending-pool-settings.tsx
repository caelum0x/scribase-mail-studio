"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@usesend/ui/src/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@usesend/ui/src/form";
import { Input } from "@usesend/ui/src/input";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useTeam } from "~/providers/team-context";
import { api } from "~/trpc/react";

const sendingPoolSchema = z.object({
  // Empty string in the form means "no pool" (shared relay); matches the
  // nullable `sendingPool` column (OCI_SMTP_POOL_<NAME>_* env vars).
  sendingPool: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z0-9_-]*$/, "Use letters, numbers, - or _ only"),
});

type SendingPoolFormValues = z.infer<typeof sendingPoolSchema>;

/**
 * Lets a team admin route this team's outgoing mail through a dedicated
 * sending pool (its own warmed-up SMTP credentials / IP) instead of the
 * shared relay, for reputation isolation on high-volume senders — the
 * closest equivalent to Resend's dedicated IPs. The pool itself must be
 * provisioned on the server first (OCI_SMTP_POOL_<NAME>_HOST/USER/PASS);
 * this only tells Scribase Mail which pool to use for this team's sends.
 */
export default function SendingPoolSettings() {
  const { currentIsAdmin } = useTeam();
  const utils = api.useUtils();
  const poolQuery = api.team.getSendingPool.useQuery(undefined, {
    enabled: currentIsAdmin,
  });
  const updatePool = api.team.setSendingPool.useMutation();

  const form = useForm<SendingPoolFormValues>({
    resolver: zodResolver(sendingPoolSchema),
    defaultValues: { sendingPool: "" },
  });

  useEffect(() => {
    if (poolQuery.data) {
      form.reset({ sendingPool: poolQuery.data.sendingPool ?? "" });
    }
  }, [poolQuery.data, form]);

  if (!currentIsAdmin) {
    return null;
  }

  function onSubmit(values: SendingPoolFormValues) {
    const sendingPool = values.sendingPool.trim() === "" ? null : values.sendingPool.trim();
    updatePool.mutate(
      { sendingPool },
      {
        onSuccess: () => {
          void utils.team.getSendingPool.invalidate();
          toast.success(
            sendingPool
              ? `Sending through the "${sendingPool}" pool`
              : "Sending through the shared relay",
          );
        },
        onError: (e) => {
          toast.error("Failed to update sending pool", {
            description: e.message,
          });
        },
      },
    );
  }

  return (
    <div className="mt-6 rounded-xl border bg-background/60 p-6 shadow-sm backdrop-blur">
      <h3 className="font-medium">Dedicated sending pool</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Advanced: isolate this team&apos;s sender reputation from every other
        team on Scribase Mail by sending through a dedicated pool of SMTP
        credentials instead of the shared relay. The pool itself has to be
        provisioned by support first — contact us with the pool name you
        were given.
      </p>
      {poolQuery.isLoading ? (
        <div className="mt-4 flex h-16 items-center justify-center">
          <Spinner className="h-5 w-5" innerSvgClass="stroke-primary" />
        </div>
      ) : (
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="mt-4 flex flex-col gap-4 md:max-w-sm"
          >
            <FormField
              control={form.control}
              name="sendingPool"
              render={({ field, formState }) => (
                <FormItem>
                  <FormLabel>Pool name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. high-volume-1" {...field} />
                  </FormControl>
                  {formState.errors.sendingPool ? (
                    <FormMessage />
                  ) : (
                    <FormDescription>
                      Leave blank to use the shared relay.
                    </FormDescription>
                  )}
                </FormItem>
              )}
            />
            <div>
              <Button type="submit" disabled={updatePool.isPending}>
                {updatePool.isPending ? (
                  <Spinner className="h-5 w-5" />
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </form>
        </Form>
      )}
    </div>
  );
}
