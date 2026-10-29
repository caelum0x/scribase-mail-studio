import http from "node:http";
import https from "node:https";

import type { PinnedWebhookAddress } from "./webhook-url-guard";

/** The amount of body text kept for a webhook delivery's audit log. */
export const PINNED_POST_RESPONSE_TEXT_LIMIT = 4_096;

export class WebhookTimeoutError extends Error {}

type DnsLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;
type PinnedLookup = (
  hostname: string,
  options: { all?: boolean } | undefined,
  callback: DnsLookupCallback,
) => void;

/** A `lookup` for `http.Agent`/`https.Agent` that always answers with the
 * one already-resolved, already-validated address — never re-resolving the
 * hostname (see the DNS-rebinding note on `pinnedPost` below). */
function fixedLookup(address: string, family: 4 | 6): PinnedLookup {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

function handlePinnedResponse(
  res: http.IncomingMessage,
  agent: http.Agent,
  responseTextLimit: number,
  resolve: (value: { status: number; responseText: string | null }) => void,
  reject: (reason: unknown) => void,
) {
  const contentType = res.headers["content-type"] ?? "";
  const isText =
    contentType.startsWith("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("application/xml");

  let received = 0;
  let text = "";
  let truncated = false;

  res.on("data", (chunk: Buffer) => {
    if (!isText || truncated) return;
    received += chunk.length;
    if (received > responseTextLimit) {
      text += chunk
        .toString("utf8")
        .slice(0, Math.max(0, responseTextLimit - (received - chunk.length)));
      truncated = true;
      res.destroy();
    } else {
      text += chunk.toString("utf8");
    }
  });
  res.on("end", () => {
    agent.destroy();
    resolve({
      status: res.statusCode ?? 0,
      responseText: isText
        ? truncated
          ? `${text}...<truncated>`
          : text
        : null,
    });
  });
  res.on("error", (error) => {
    agent.destroy();
    reject(error);
  });
}

/**
 * POSTs to `params.url`, but connects the socket to `params.pinned.address`
 * instead of letting the HTTP client resolve `params.url`'s host again.
 *
 * Webhooks are POSTed from inside the deployment network. If the only check
 * is "does this hostname currently resolve to a public address" at the
 * moment a webhook is created or re-validated, a DNS-rebinding host can
 * answer a public address for that check and a private one (loopback,
 * link-local, cloud metadata, an internal Docker service) moments later,
 * when the real connection for an actual delivery is made — fetch()/undici
 * would re-resolve the hostname a second time to connect, reopening exactly
 * that gap. Connecting to the one address `resolvePinnedWebhookAddress`
 * (`./webhook-url-guard`) already resolved and checked closes it: the name
 * is never resolved a second time for this call. TLS servername/certificate
 * checks still use the real hostname — only the TCP destination is pinned.
 * `params.pinned.address` is `null` only for a host an operator explicitly
 * allowed via WEBHOOK_ALLOWED_PRIVATE_HOSTS; that one case connects
 * normally, there being nothing to pin against.
 *
 * Reads at most `params.responseTextLimit` bytes of a text/json/xml body.
 */
export function pinnedPost(params: {
  url: string;
  pinned: PinnedWebhookAddress;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  responseTextLimit?: number;
}): Promise<{ status: number; responseText: string | null }> {
  const target = new URL(params.url);
  const isHttps = target.protocol === "https:";
  const { address, family } = params.pinned;
  const lookup = address ? fixedLookup(address, family ?? 4) : undefined;
  const responseTextLimit =
    params.responseTextLimit ?? PINNED_POST_RESPONSE_TEXT_LIMIT;

  const agent: http.Agent = isHttps
    ? new https.Agent({ keepAlive: false, lookup })
    : new http.Agent({ keepAlive: false, lookup });
  const requestOptions = { method: "POST", headers: params.headers, agent };

  return new Promise((resolve, reject) => {
    const req = isHttps
      ? https.request(target, requestOptions, (res) =>
          handlePinnedResponse(res, agent, responseTextLimit, resolve, reject),
        )
      : http.request(target, requestOptions, (res) =>
          handlePinnedResponse(res, agent, responseTextLimit, resolve, reject),
        );
    req.on("timeout", () => {
      agent.destroy();
      req.destroy(new WebhookTimeoutError("Webhook request timed out"));
    });
    req.on("error", (error) => {
      agent.destroy();
      reject(error);
    });
    req.setTimeout(params.timeoutMs);
    req.write(params.body);
    req.end();
  });
}
