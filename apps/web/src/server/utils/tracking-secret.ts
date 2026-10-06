import { env } from "~/env";

/** HMAC secret for signed open/click tracking URLs. */
export function getTrackingSecret(): string {
  return env.NEXTAUTH_SECRET ?? "scribase-mail-dev-tracking-secret";
}
