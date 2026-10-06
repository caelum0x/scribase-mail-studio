import type { Metadata } from "next";
import { LegalPage } from "~/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms - Scribase Mail",
  description: "Terms for using Scribase Mail.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      intro="Scribase Mail is part of Scribase and is covered by the Scribase terms of service."
      canonicalUrl="https://scribase.com/terms"
      sections={[
        {
          heading: "Acceptable use",
          body: "Only send email to people who asked to hear from you. Unsolicited bulk email, phishing, malware and purchased or scraped lists are not allowed. Marketing email must include a working unsubscribe link.",
        },
        {
          heading: "Sending limits",
          body: "Accounts with high bounce or complaint rates may be paused to protect deliverability for everyone.",
        },
        {
          heading: "Open source",
          body: "The Scribase Mail software is licensed under the GNU AGPL-3.0. These terms cover the hosted service, not your rights under that license.",
        },
      ]}
    />
  );
}
