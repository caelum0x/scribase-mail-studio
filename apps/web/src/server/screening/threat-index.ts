import { createHash } from "crypto";
import { hostCandidates } from "./url-extraction";

/**
 * Compact in-memory lookup for threat-feed hostnames. Each host is stored as
 * the first 64 bits of its SHA-256, sorted, so ~400k phishing domains take
 * ~3 MB in Redis and in each process instead of ~40 MB as strings.
 */

/**
 * Shared platforms that feeds list because phishers host pages under them.
 * Blocking the whole platform would reject legitimate mail, so a feed entry
 * for exactly these hosts is ignored (subdomains such as evil.vercel.app are
 * still matched).
 */
export const FEED_EXEMPT_HOSTS: ReadonlySet<string> = new Set([
  "google.com",
  "sites.google.com",
  "docs.google.com",
  "drive.google.com",
  "forms.gle",
  "storage.googleapis.com",
  "firebasestorage.googleapis.com",
  "github.com",
  "raw.githubusercontent.com",
  "github.io",
  "dropbox.com",
  "onedrive.live.com",
  "1drv.ms",
  "sharepoint.com",
  "microsoft.com",
  "office.com",
  "forms.office.com",
  "apple.com",
  "icloud.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "notion.so",
  "notion.site",
  "canva.com",
  "wixsite.com",
  "weebly.com",
  "webflow.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "blogspot.com",
  "wordpress.com",
  "typeform.com",
  "jotform.com",
  "scribase.com",
]);

const HOST_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;

function normalizeFeedEntry(token: string): string | null {
  let value = token.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }
  value = value.replace(/^\*\./, "").replace(/\.$/, "");
  return HOST_PATTERN.test(value) ? value : null;
}

function feedLineHost(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith("!")) return null;
  const tokens = line.split(/\s+/);
  // hosts-file format: "0.0.0.0 evil.test"
  const token =
    tokens.length > 1 && /^(?:0\.0\.0\.0|127\.0\.0\.1)$/.test(tokens[0]!)
      ? tokens[1]!
      : tokens.length === 1
        ? tokens[0]!
        : null;
  return token ? normalizeFeedEntry(token) : null;
}

/**
 * Calls `fn` for each hostname in a plain-text feed (one domain, URL or
 * hosts-file entry per line). Scans in place instead of splitting so a large
 * feed doesn't become hundreds of thousands of line strings at once.
 */
export function forEachFeedHost(
  text: string,
  fn: (host: string) => void, // eslint-disable-line no-unused-vars
): void {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const host = feedLineHost(text.slice(start, end));
    if (host) fn(host);
    start = end + 1;
  }
}

export function parseFeedHosts(text: string): string[] {
  const hosts: string[] = [];
  forEachFeedHost(text, (host) => hosts.push(host));
  return hosts;
}

export function hashHost(host: string): bigint {
  return createHash("sha256")
    .update(host.toLowerCase())
    .digest()
    .readBigUInt64BE(0);
}

/** Collects host hashes into a growable typed array (8 bytes per host). */
export class HostHashBuilder {
  private hashes = new BigUint64Array(1024);
  private length = 0;

  add(host: string): void {
    if (this.length === this.hashes.length) {
      const grown = new BigUint64Array(this.hashes.length * 2);
      grown.set(this.hashes);
      this.hashes = grown;
    }
    this.hashes[this.length++] = hashHost(host);
  }

  addFeedText(text: string): number {
    const before = this.length;
    forEachFeedHost(text, (host) => this.add(host));
    return this.length - before;
  }

  /** Sorted, de-duplicated hashes. */
  build(): BigUint64Array {
    const sorted = this.hashes.subarray(0, this.length).sort();
    let unique = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0 || sorted[i] !== sorted[unique - 1]) {
        sorted[unique++] = sorted[i]!;
      }
    }
    return sorted.slice(0, unique);
  }
}

export function buildHostIndex(hosts: Iterable<string>): BigUint64Array {
  const builder = new HostHashBuilder();
  for (const host of hosts) builder.add(host);
  return builder.build();
}

function contains(sorted: BigUint64Array, value: bigint): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const current = sorted[mid]!;
    if (current === value) return true;
    if (current < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export class ThreatIndex {
  private readonly hashes: BigUint64Array;
  private readonly exempt: ReadonlySet<string>;

  constructor(hashes: BigUint64Array, extraExemptHosts: Iterable<string> = []) {
    this.hashes = hashes;
    this.exempt = new Set([...FEED_EXEMPT_HOSTS, ...extraExemptHosts]);
  }

  static empty(): ThreatIndex {
    return new ThreatIndex(new BigUint64Array(0));
  }

  get size(): number {
    return this.hashes.length;
  }

  /** True when the host or one of its parent domains is on a feed. */
  isListed(host: string): boolean {
    if (this.hashes.length === 0) return false;
    return hostCandidates(host).some(
      (candidate) =>
        !this.exempt.has(candidate) &&
        contains(this.hashes, hashHost(candidate)),
    );
  }
}
