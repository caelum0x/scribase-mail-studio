"use client";

import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import {
  PRICING_PLAN_ORDER,
  PRICING_PLANS,
  type PricingPlanId,
} from "@usesend/lib/src/constants/pricing";
import { Check } from "lucide-react";
import { isEntitledSubscriptionStatus } from "~/lib/subscription-status";
import { useTeam } from "~/providers/team-context";
import { api } from "~/trpc/react";
import { UpgradeButton } from "./UpgradeButton";

const RANK: Record<PricingPlanId, number> = { FREE: 0, PRO: 1, SCALE: 2 };

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Free / Pro / Scale cards with the right action for the team's plan. */
export const PlanPicker = () => {
  const { currentTeam } = useTeam();
  const utils = api.useUtils();
  const status = api.billing.getBillingStatus.useQuery();
  const subscription = api.billing.getSubscriptionDetails.useQuery();
  const changePlan = api.billing.changePlan.useMutation();
  const cancel = api.billing.cancelSubscription.useMutation();

  const hasLiveSubscription = isEntitledSubscriptionStatus(
    subscription.data?.status,
  );
  const current: PricingPlanId =
    currentTeam?.isActive && currentTeam.plan ? currentTeam.plan : "FREE";
  const available = status.data?.availablePlans ?? [];

  const refresh = async () => {
    await utils.billing.getSubscriptionDetails.invalidate();
    await utils.team.getTeams.invalidate();
  };

  const onChange = async (plan: "PRO" | "SCALE") => {
    try {
      await changePlan.mutateAsync({ plan });
      toast.success("Plan change requested. It applies in a few seconds.");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Plan change failed");
    }
  };

  const onDowngradeToFree = async () => {
    try {
      await cancel.mutateAsync();
      toast.success("Your plan ends at the end of the billing period.");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Cancel failed");
    }
  };

  const action = (id: PricingPlanId) => {
    if (id === current) return <Note>Current plan</Note>;
    if (status.data && !status.data.configured) {
      return <Note>Billing not configured</Note>;
    }
    if (id === "FREE") {
      if (!hasLiveSubscription || subscription.data?.cancelAtPeriodEnd) {
        return null;
      }
      return (
        <Button
          variant="outline"
          onClick={onDowngradeToFree}
          disabled={cancel.isPending}
        >
          {cancel.isPending ? <Spinner className="w-4 h-4" /> : "Downgrade"}
        </Button>
      );
    }
    if (!available.includes(id)) return null;
    const label = RANK[id] > RANK[current] ? "Upgrade" : "Downgrade";
    if (hasLiveSubscription) {
      return (
        <Button
          variant={label === "Upgrade" ? "default" : "outline"}
          onClick={() => onChange(id)}
          disabled={changePlan.isPending}
        >
          {changePlan.isPending ? <Spinner className="w-4 h-4" /> : label}
        </Button>
      );
    }
    return <UpgradeButton plan={id} label={label} className="" />;
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {PRICING_PLAN_ORDER.map((id) => {
        const plan = PRICING_PLANS[id];
        return (
          <div
            key={id}
            className={`flex flex-col rounded-xl border p-5 ${
              id === current ? "border-foreground" : "border-border"
            }`}
          >
            <div className="font-medium">{plan.name}</div>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="font-mono text-2xl font-semibold">
                ${plan.priceUsdMonthly}
              </span>
              <span className="text-sm text-muted-foreground">/ month</span>
            </div>
            <ul className="mt-4 flex-1 space-y-2">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm">
                  <Check className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5">{action(id)}</div>
          </div>
        );
      })}
    </div>
  );
};
