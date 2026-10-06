import type { Metadata } from "next";
import { LegalPage } from "~/components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy - Scribase Mail",
  description: "How Scribase Mail handles data.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      intro="Scribase Mail is part of Scribase and is covered by the Scribase privacy policy."
      canonicalUrl="https://scribase.com/privacy"
      sections={[
        {
          heading: "Email data",
          body: "We store the messages you send, delivery events and contact lists so you can see what happened to each email. Message bodies can be removed automatically after a retention period you configure.",
        },
        {
          heading: "Delivery",
          body: "Email is relayed through Oracle Cloud Infrastructure Email Delivery in the EU (Frankfurt) region.",
        },
        {
          heading: "Tracking",
          body: "Open and click tracking is off by default and can be enabled per domain. When enabled, links are rewritten and a tracking pixel is added.",
        },
      ]}
    />
  );
}
