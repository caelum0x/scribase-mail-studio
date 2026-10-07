import type { ApiPermission } from "@prisma/client";

/**
 * Central API key authorization policy for every public API surface
 * (native `/api/v1/*` and the Resend-compatible `/api/resend/*`).
 *
 * Two independent restrictions exist on an API key:
 *
 * 1. Permission. `FULL` keys may call any route. `SENDING` keys (Resend's
 *    `sending_access`) may only send email: `POST /emails` and
 *    `POST /emails/batch`. Everything else is denied, including reading
 *    emails back, which matches Resend.
 *
 * 2. Domain restriction (`ApiKey.domainId`). A domain-restricted key is
 *    scoped to one domain. Domain-scoped resources (emails, domains,
 *    campaigns, analytics) are filtered to that domain by the route handlers.
 *    Team-wide resources that are not tied to a domain (contacts, contact
 *    books, API keys, webhooks, ...) and creating new domains are denied here.
 */

export type ApiKeyAccess = {
  permission: ApiPermission | null | undefined;
  domainId: number | null | undefined;
};

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: "SENDING_ONLY" | "DOMAIN_RESTRICTED" };

/** API surfaces the policy understands, keyed by their path prefix. */
const SURFACE_PREFIXES = ["/api/v1", "/api/resend"] as const;

/** Strip the surface prefix and any trailing slash: `/api/v1/emails/` -> `/emails`. */
export function toResourcePath(path: string): string {
  let resourcePath = path;
  for (const prefix of SURFACE_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      resourcePath = path.slice(prefix.length);
      break;
    }
  }
  if (resourcePath.length > 1 && resourcePath.endsWith("/")) {
    resourcePath = resourcePath.slice(0, -1);
  }
  return resourcePath === "" ? "/" : resourcePath;
}

const SENDING_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/emails" },
  { method: "POST", path: "/emails/batch" },
];

export function isSendingRoute(method: string, path: string): boolean {
  const resourcePath = toResourcePath(path);
  const upperMethod = method.toUpperCase();
  return SENDING_ROUTES.some(
    (route) => route.method === upperMethod && route.path === resourcePath,
  );
}

/**
 * Resource roots a domain-restricted key may reach. The handlers for these
 * roots filter by `team.apiKey.domainId`.
 */
const DOMAIN_SCOPED_ROOTS = new Set([
  "emails",
  "domains",
  "campaigns",
  "broadcasts",
  "analytics",
]);

export function isDomainScopedRoute(method: string, path: string): boolean {
  const resourcePath = toResourcePath(path);
  const segments = resourcePath.split("/").filter(Boolean);
  const root = segments[0];

  if (!root || !DOMAIN_SCOPED_ROOTS.has(root)) {
    return false;
  }

  // A key bound to one domain cannot register additional domains.
  if (root === "domains" && segments.length === 1 && method.toUpperCase() === "POST") {
    return false;
  }

  return true;
}

export function checkApiKeyAccess(
  access: ApiKeyAccess,
  method: string,
  path: string,
): AccessDecision {
  if (access.permission !== "FULL" && !isSendingRoute(method, path)) {
    // Anything that is not explicitly FULL is treated as sending-only.
    return { allowed: false, reason: "SENDING_ONLY" };
  }

  if (
    access.domainId !== null &&
    access.domainId !== undefined &&
    !isDomainScopedRoute(method, path)
  ) {
    return { allowed: false, reason: "DOMAIN_RESTRICTED" };
  }

  return { allowed: true };
}

export const SENDING_ONLY_MESSAGE =
  "This API key is restricted to only send emails.";
export const DOMAIN_RESTRICTED_MESSAGE =
  "This API key is restricted to a single domain and cannot access this resource.";
