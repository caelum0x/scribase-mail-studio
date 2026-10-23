"use client";

import AuditLogList from "./audit-log-list";

export default function AuditPage() {
  return (
    <div>
      <p className="text-sm text-muted-foreground">
        Every sensitive change in this team &mdash; who did it, when, and
        from where. Logs are kept for 90 days.
      </p>
      <AuditLogList />
    </div>
  );
}
