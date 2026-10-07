"use client";

import { useState } from "react";
import { Button } from "@usesend/ui/src/button";
import { Card } from "@usesend/ui/src/card";
import { Spinner } from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import { format } from "date-fns";
import { useTeam } from "~/providers/team-context";
import { api } from "~/trpc/react";
import { PlanDetails } from "~/components/payments/PlanDetails";
import { PlanPicker } from "~/components/payments/PlanPicker";

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  past_due: "Past due",
  on_hold: "On hold (payment failed)",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Failed",
  pending: "Pending",
};

export default function SettingsPage() {
  const { currentTeam, currentIsAdmin } = useTeam();
  const status = api.billing.getBillingStatus.useQuery();
  const manageSessionUrl = api.billing.getManageSessionUrl.useMutation();
  const resume = api.billing.resumeSubscription.useMutation();
  const updateBillingEmailMutation =
    api.billing.updateBillingEmail.useMutation();

  const { data: subscription } = api.billing.getSubscriptionDetails.useQuery();
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [billingEmail, setBillingEmail] = useState(
    currentTeam?.billingEmail || "",
  );

  const apiUtils = api.useUtils();

  const onManageClick = async () => {
    try {
      const url = await manageSessionUrl.mutateAsync();
      if (url) {
        window.location.href = url;
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not open the portal",
      );
    }
  };

  const onResume = async () => {
    try {
      await resume.mutateAsync();
      await apiUtils.billing.getSubscriptionDetails.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Resume failed");
    }
  };

  const handleEditEmail = () => {
    setBillingEmail(currentTeam?.billingEmail || "");
    setIsEditingEmail(true);
  };

  const handleSaveEmail = async () => {
    try {
      await updateBillingEmailMutation.mutateAsync({ billingEmail });
      await apiUtils.team.getTeams.invalidate();
      setIsEditingEmail(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save the email",
      );
    }
  };

  if (!currentIsAdmin) {
    return null;
  }

  if (!currentTeam?.plan || status.isLoading) {
    return (
      <div className="flex justify-center items-center h-full">
        <Spinner className="w-4 h-4" />
      </div>
    );
  }

  const configured = Boolean(status.data?.configured);

  return (
    <div className="space-y-8">
      <Card className="rounded-xl mt-10 p-8 px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PlanDetails />
          {configured && currentTeam.billingCustomerId ? (
            <Button
              variant="outline"
              onClick={onManageClick}
              disabled={manageSessionUrl.isPending}
            >
              {manageSessionUrl.isPending ? (
                <Spinner className="w-4 h-4" />
              ) : (
                "Invoices and payment method"
              )}
            </Button>
          ) : null}
        </div>
        {!configured ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Billing not configured. Paid plans become available once the
            operator connects Dodo Payments.
          </p>
        ) : null}
        <div className="mt-8">
          <PlanPicker />
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-8">
        <Card className="p-6">
          <div className="text-sm text-muted-foreground">Subscription</div>
          {subscription ? (
            <div className="mt-2 space-y-1">
              <div className="text-lg">
                {STATUS_LABELS[subscription.status] ?? subscription.status}
              </div>
              <div className="text-sm text-muted-foreground">
                {subscription.cancelAtPeriodEnd
                  ? "Ends on "
                  : "Next billing date: "}
                {subscription.currentPeriodEnd
                  ? format(
                      new Date(subscription.currentPeriodEnd),
                      "MMM dd, yyyy",
                    )
                  : "N/A"}
              </div>
              {subscription.cancelAtPeriodEnd && configured ? (
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={onResume}
                  disabled={resume.isPending}
                >
                  {resume.isPending ? (
                    <Spinner className="w-4 h-4" />
                  ) : (
                    "Keep my plan"
                  )}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground mt-2">
              No subscription
            </div>
          )}
        </Card>

        <Card className="p-6">
          <div>
            <div className="text-sm text-muted-foreground">Billing Email</div>
            {isEditingEmail ? (
              <div className="mt-2">
                <div className="flex items-center gap-2">
                  <input
                    type="email"
                    value={billingEmail}
                    onChange={(e) => setBillingEmail(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder="Enter billing email"
                  />
                  <Button
                    onClick={handleSaveEmail}
                    disabled={updateBillingEmailMutation.isPending}
                    size="sm"
                  >
                    {updateBillingEmailMutation.isPending ? (
                      <Spinner className="w-4 h-4" />
                    ) : (
                      "Save"
                    )}
                  </Button>
                  <Button
                    onClick={() => setIsEditingEmail(false)}
                    variant="outline"
                    size="sm"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-2">
                <div className="flex items-center gap-2">
                  <div className="font-mono">
                    {currentTeam?.billingEmail || "No billing email set"}
                  </div>
                  <Button onClick={handleEditEmail} variant="default" size="sm">
                    Edit
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
