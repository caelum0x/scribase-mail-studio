import { redirect } from "next/navigation";

import { DashboardProvider } from "~/providers/dashboard-provider";
import { NextAuthProvider } from "~/providers/next-auth";
import { getServerAuthSession } from "~/server/auth";
import { DashboardLayout } from "./dasboard-layout";

/**
 * Every page under this route group previously rendered its full shell for a
 * waitlisted user (only the tRPC calls inside it failed with UNAUTHORIZED,
 * one query at a time, with no explanation). A brand new external sign-up
 * who isn't auto-approved landed straight on a broken-looking Analytics
 * dashboard instead of the "You're on the waitlist" page `/` already shows —
 * the sign-in callback goes straight to `/dashboard`, bypassing `/`'s check.
 * This mirrors `src/app/page.tsx`'s redirect at the layout level so it
 * covers all 30+ routes in this group, not just one page at a time.
 */
export default async function AuthenticatedDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerAuthSession();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.isWaitlisted) {
    redirect("/wait-list");
  }

  return (
    <NextAuthProvider>
      <DashboardProvider>
        <DashboardLayout>{children}</DashboardLayout>
      </DashboardProvider>
    </NextAuthProvider>
  );
}
