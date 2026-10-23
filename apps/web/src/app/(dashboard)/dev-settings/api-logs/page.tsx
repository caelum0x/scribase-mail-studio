"use client";

import { H1 } from "@usesend/ui";
import ApiLogList from "./api-log-list";

export default function ApiLogsPage() {
  return (
    <div>
      <div className="flex justify-between items-center">
        <div>
          <H1>API Logs</H1>
          <p className="text-sm text-muted-foreground mt-1">
            Every request to the public API, as it actually happened. Use this
            to check whether an SDK call reached the server and what it got
            back.
          </p>
        </div>
      </div>
      <ApiLogList />
    </div>
  );
}
