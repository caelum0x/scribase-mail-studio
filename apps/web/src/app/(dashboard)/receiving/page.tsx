"use client";

import { H1 } from "@usesend/ui";
import ReceivedEmailList from "./received-email-list";

export default function ReceivingPage() {
  return (
    <div>
      <div className="flex justify-between items-center">
        <H1>Received Emails</H1>
      </div>
      <ReceivedEmailList />
    </div>
  );
}
