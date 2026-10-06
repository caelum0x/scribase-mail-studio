"use client";

import ProviderStatusCard from "./provider-status";
import ProviderSendingSettings from "./provider-sending-settings";

export default function AdminEmailProviderPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Email provider</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Scribase Mail sends through Oracle Cloud Email Delivery. Credentials
          come from the server environment.
        </p>
      </div>
      <ProviderStatusCard />
      <ProviderSendingSettings />
    </div>
  );
}
