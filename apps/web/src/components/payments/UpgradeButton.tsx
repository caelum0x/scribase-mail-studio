import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import { api } from "~/trpc/react";

interface UpgradeButtonProps {
  plan?: "PRO" | "SCALE";
  label?: string;
  className?: string;
}

export const UpgradeButton = ({
  plan = "PRO",
  label = "Upgrade",
  className = "mt-4 w-[120px]",
}: UpgradeButtonProps) => {
  const status = api.billing.getBillingStatus.useQuery();
  const checkoutMutation = api.billing.createCheckoutSession.useMutation();

  if (status.data && !status.data.configured) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        Billing not configured
      </p>
    );
  }

  const onClick = async () => {
    try {
      const url = await checkoutMutation.mutateAsync({ plan });
      if (url) {
        window.location.href = url;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Checkout failed");
    }
  };

  return (
    <Button
      onClick={onClick}
      className={className}
      disabled={checkoutMutation.isPending || status.isLoading}
    >
      {checkoutMutation.isPending ? <Spinner className="w-4 h-4" /> : label}
    </Button>
  );
};
