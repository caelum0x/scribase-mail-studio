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
import type { ProviderSetting } from "@prisma/client";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "~/trpc/react";

const FormSchema = z.object({
  settingsId: z.string(),
  sendRate: z.coerce.number().int().min(1).max(1000),
  transactionalQuota: z.coerce.number().int().min(0).max(100),
});

type FormValues = z.infer<typeof FormSchema>;

export default function ProviderSendingSettings() {
  const settingsQuery = api.admin.getProviderSettings.useQuery();

  if (settingsQuery.isLoading) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Spinner className="h-6 w-6" innerSvgClass="stroke-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {settingsQuery.data?.map((setting) => (
        <SendingSettingsForm key={setting.id} setting={setting} />
      ))}
    </div>
  );
}

function SendingSettingsForm({ setting }: { setting: ProviderSetting }) {
  const utils = api.useUtils();
  const updateSettings = api.admin.updateProviderSettings.useMutation();

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      settingsId: setting.id,
      sendRate: setting.sendRateLimit,
      transactionalQuota: setting.transactionalQuota,
    },
  });

  function onSubmit(data: FormValues) {
    updateSettings.mutate(data, {
      onSuccess: () => {
        utils.admin.invalidate();
        toast.success("Sending settings saved");
      },
      onError: (e) => {
        toast.error("Failed to update", { description: e.message });
      },
    });
  }

  return (
    <div className="rounded-xl border bg-background/60 p-6 shadow-sm backdrop-blur">
      <h3 className="font-medium">Sending ({setting.region})</h3>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="mt-4 grid gap-6 md:grid-cols-2"
        >
          <FormField
            control={form.control}
            name="sendRate"
            render={({ field, formState }) => (
              <FormItem>
                <FormLabel>Send rate</FormLabel>
                <FormControl>
                  <Input placeholder="1" {...field} />
                </FormControl>
                {formState.errors.sendRate ? (
                  <FormMessage />
                ) : (
                  <FormDescription>
                    Emails sent in parallel. Keep within your Oracle Cloud Email
                    Delivery limits.
                  </FormDescription>
                )}
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="transactionalQuota"
            render={({ field, formState }) => (
              <FormItem>
                <FormLabel>Transactional share (%)</FormLabel>
                <FormControl>
                  <Input placeholder="50" {...field} />
                </FormControl>
                {formState.errors.transactionalQuota ? (
                  <FormMessage />
                ) : (
                  <FormDescription>
                    Share of the send rate reserved for transactional email.
                  </FormDescription>
                )}
              </FormItem>
            )}
          />
          <div className="md:col-span-2">
            <Button type="submit" disabled={updateSettings.isPending}>
              {updateSettings.isPending ? (
                <Spinner className="h-5 w-5" />
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
