import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import { api } from "~/trpc/react";
import { track } from "~/lib/track";

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
        // Second step of the real new-customer funnel (see login-page.tsx's
        // signup_email_submitted): a real Dodo checkout session was created and
        // the visitor is about to be redirected to pay, fired before the
        // redirect since nothing on this page runs after it.
        track("checkout_started", { plan });
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
