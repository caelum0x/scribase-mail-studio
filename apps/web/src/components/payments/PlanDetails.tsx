import { PRICING_PLANS } from "@usesend/lib/src/constants/pricing";
import { api } from "~/trpc/react";
import { useTeam } from "~/providers/team-context";
import { Badge } from "@usesend/ui/src/badge";
import { format } from "date-fns";

export const PlanDetails = () => {
  const subscriptionQuery = api.billing.getSubscriptionDetails.useQuery();
  const { currentTeam } = useTeam();

  if (subscriptionQuery.isLoading || !currentTeam) {
    return null;
  }

  const activePlan =
    currentTeam.isActive && currentTeam.plan ? currentTeam.plan : "FREE";
  const plan = PRICING_PLANS[activePlan];
  const onHold =
    !currentTeam.isActive && subscriptionQuery.data?.status === "on_hold";

  return (
    <div>
      <div className="text-lg">{plan.name}</div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-muted-foreground text-sm">Current plan</div>
        {subscriptionQuery.data?.cancelAtPeriodEnd && (
          <Badge variant="secondary">
            Ends {format(subscriptionQuery.data.cancelAtPeriodEnd, "MMM dd")}
          </Badge>
        )}
        {onHold && (
          <Badge variant="secondary">
            Payment failed. Update your payment method.
          </Badge>
        )}
      </div>
    </div>
  );
};
