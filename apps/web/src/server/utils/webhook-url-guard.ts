import dns from "node:dns/promises";
import { isPrivateIp } from "../public-api/resend/email-schema";

/**
 * SSRF guard for customer webhook URLs. Webhooks are POSTed from inside the
 * deployment network, so a URL pointing at a private, loopback, link-local
 * (cloud metadata) or internal Docker host would let a customer reach
 * internal services and read the reply through the delivery log.
 *
 * WEBHOOK_ALLOWED_PRIVATE_HOSTS (comma separated hostnames) lets an operator
 * allow specific internal hosts, e.g. for a smoke test receiver.
 */
export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

type Lookup = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: Lookup = (hostname) =>
  dns.lookup(hostname, { all: true });

function allowedPrivateHosts(): Set<string> {
  return new Set(
    (process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The host was resolved once; a delivery must connect to exactly `address`
 * rather than letting the HTTP client resolve the name again (DNS rebinding:
 * a host can answer a public address for this check and a private one a
 * moment later, when the real connection is made). `null` only for a host an
 * operator explicitly allowed via WEBHOOK_ALLOWED_PRIVATE_HOSTS, where there
 * is nothing to pin against. */
export interface PinnedWebhookAddress {
  readonly hostname: string;
  readonly address: string | null;
  readonly family: 4 | 6 | null;
}

function addressFamily(address: string): 4 | 6 {
  return address.includes(":") ? 6 : 4;
}

/**
 * Validates a webhook URL (scheme, credentials, not loopback/private) and
 * resolves its host to one checked public address. Callers that actually
 * make the request must connect to the returned `address`, not re-resolve
 * the hostname — see [`PinnedWebhookAddress`].
 */
export async function resolvePinnedWebhookAddress(
  rawUrl: string,
  lookup: Lookup = defaultLookup,
): Promise<PinnedWebhookAddress> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookUrlError("Invalid webhook URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebhookUrlError("Webhook URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new WebhookUrlError("Webhook URL must not contain credentials.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (allowedPrivateHosts().has(hostname)) {
    return { hostname, address: null, family: null };
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new WebhookUrlError("Webhook URL must be a public address.");
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new WebhookUrlError(`Webhook host ${hostname} does not resolve.`);
  }
  if (
    addresses.length === 0 ||
    addresses.some((a) => isPrivateIp(a.address))
  ) {
    throw new WebhookUrlError("Webhook URL must be a public address.");
  }

  const address = addresses[0]!.address;
  return { hostname, address, family: addressFamily(address) };
}

export async function assertPublicWebhookUrl(
  rawUrl: string,
  lookup: Lookup = defaultLookup,
): Promise<void> {
  await resolvePinnedWebhookAddress(rawUrl, lookup);
}
