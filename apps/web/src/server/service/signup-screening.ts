import { domainToASCII } from "node:url";

import disposableDomainList from "~/server/data/disposable-email-domains.json";

/**
 * Signup screening for the hosted (cloud) waitlist.
 *
 * Pure helpers that decide whether an email address looks like a real
 * business mailbox: not a consumer/free provider, not a disposable inbox, and
 * the domain publishes a usable MX record. Everything fails closed: when in
 * doubt the user stays on the waitlist for manual review.
 */

export type ScreeningReason =
  | "ok"
  | "invalid_email"
  | "free_provider"
  | "disposable"
  | "no_mx"
  | "mx_lookup_failed";

export type ScreeningResult = {
  ok: boolean;
  reason: ScreeningReason;
  /** Normalised ASCII domain (punycode), when the email parsed. */
  domain?: string;
};

export type MxRecord = { exchange: string; priority: number };
export type ResolveMx = (domain: string) => Promise<MxRecord[]>;

/** Consumer / free mailbox providers (exact domains, any subdomain also matches). */
export const FREE_PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "google.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com",
  "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es",
  "outlook.fr", "outlook.de", "outlook.es", "outlook.it", "live.co.uk", "live.fr",
  "yahoo.com", "ymail.com", "rocketmail.com", "yahoo.co.uk", "yahoo.fr",
  "yahoo.de", "yahoo.es", "yahoo.it", "yahoo.co.jp", "yahoo.com.br", "yahoo.co.in",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "aim.com", "verizon.net", "att.net", "comcast.net", "sbcglobal.net",
  "proton.me", "protonmail.com", "protonmail.ch", "pm.me", "tutanota.com",
  "tutanota.de", "tuta.io", "tuta.com", "keemail.me",
  "gmx.com", "gmx.net", "gmx.de", "gmx.at", "gmx.ch", "web.de", "t-online.de",
  "freenet.de", "posteo.de", "posteo.net", "mailbox.org",
  "yandex.com", "yandex.ru", "ya.ru", "mail.ru", "inbox.ru", "list.ru", "bk.ru",
  "rambler.ru",
  "zoho.com", "zohomail.com", "zohomail.eu", "zoho.eu",
  "mail.com", "email.com", "usa.com", "post.com", "inbox.com",
  "fastmail.com", "fastmail.fm", "hey.com", "hushmail.com", "runbox.com",
  "qq.com", "163.com", "126.com", "yeah.net", "sina.com", "sohu.com", "aliyun.com",
  "naver.com", "daum.net", "hanmail.net",
  "libero.it", "virgilio.it", "orange.fr", "wanadoo.fr", "free.fr", "laposte.net",
  "sfr.fr", "btinternet.com", "sky.com", "virginmedia.com", "ntlworld.com",
  "seznam.cz", "wp.pl", "o2.pl", "interia.pl", "onet.pl",
  "rediffmail.com", "yandex.com.tr", "mynet.com", "uol.com.br", "bol.com.br",
  "terra.com.br", "duck.com", "skiff.com", "startmail.com", "mailfence.com",
  "lycos.com", "excite.com", "juno.com", "earthlink.net", "cox.net", "charter.net",
  "bigpond.com", "optusnet.com.au", "shaw.ca", "rogers.com", "telus.net",
]);

/**
 * Brand labels of large free providers. A domain whose registrable label is one
 * of these (gmail.de, yahoo.com.ar, outlook.jp, ...) is treated as free too.
 */
const FREE_PROVIDER_BRANDS: ReadonlySet<string> = new Set([
  "gmail", "googlemail", "hotmail", "outlook", "yahoo", "ymail", "icloud",
  "aol", "protonmail", "proton", "gmx", "yandex", "zoho", "zohomail",
  "tutanota", "mailinator", "qq", "naver", "rediffmail", "libero",
]);

/** Second-level labels used under country TLDs (example.co.uk, example.com.au). */
const SECOND_LEVEL_SUFFIX_LABELS: ReadonlySet<string> = new Set([
  "co", "com", "net", "org", "ac", "gov", "edu", "or", "ne", "go", "gen", "ltd", "plc",
]);

const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(
  disposableDomainList as string[],
);

const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Extract and normalise the domain of an email address. Lower-cases, strips a
 * trailing dot, converts IDN to punycode and validates every label. Returns
 * null for anything that is not a plain hostname with at least two labels.
 */
export function normalizeEmailDomain(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") return null;
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  // Only one "@" is allowed in what we accept for screening.
  if (trimmed.indexOf("@") !== at) return null;

  let domain = trimmed.slice(at + 1).toLowerCase();
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (!domain || domain.startsWith("[")) return null; // no IP literals

  const ascii = domainToASCII(domain);
  if (!ascii || ascii.length > 253) return null;

  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => DOMAIN_LABEL.test(l))) return null;
  // Top-level label must not be all digits (rules out bare IPv4).
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null;

  return ascii;
}

/** True when `domain` equals or is a subdomain of an entry in `set`. */
function matchesDomainOrParent(domain: string, set: ReadonlySet<string>): boolean {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (set.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/** Best-effort registrable label (without a public suffix list). */
function registrableLabel(domain: string): string | undefined {
  const labels = domain.split(".");
  if (labels.length >= 3) {
    const sld = labels[labels.length - 2]!;
    const tld = labels[labels.length - 1]!;
    if (tld.length === 2 && SECOND_LEVEL_SUFFIX_LABELS.has(sld)) {
      return labels[labels.length - 3];
    }
  }
  return labels[labels.length - 2];
}

export function isFreeProviderDomain(domain: string): boolean {
  if (matchesDomainOrParent(domain, FREE_PROVIDER_DOMAINS)) return true;
  const label = registrableLabel(domain);
  return label !== undefined && FREE_PROVIDER_BRANDS.has(label);
}

export function isDisposableDomain(domain: string): boolean {
  return matchesDomainOrParent(domain, DISPOSABLE_DOMAINS);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mx lookup timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * True when the domain publishes at least one usable MX host. A null MX
 * (RFC 7505, exchange "" or "."), localhost or IP-literal exchanges do not count.
 */
export async function checkMx(
  domain: string,
  resolveMx: ResolveMx,
  timeoutMs = 3000,
): Promise<"ok" | "no_mx" | "mx_lookup_failed"> {
  let records: MxRecord[];
  try {
    records = await withTimeout(resolveMx(domain), timeoutMs);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") {
      return "no_mx";
    }
    return "mx_lookup_failed";
  }
  const usable = (records ?? []).filter((r) => {
    const host = (r?.exchange ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!host) return false;
    if (host === "localhost" || host.endsWith(".localhost")) return false;
    if (/^[0-9.]+$/.test(host) || host.includes(":")) return false;
    return true;
  });
  return usable.length > 0 ? "ok" : "no_mx";
}

/** Full screening of one email address. Fails closed. */
export async function screenSignupEmail(
  email: string | null | undefined,
  deps: { resolveMx: ResolveMx; timeoutMs?: number },
): Promise<ScreeningResult> {
  const domain = normalizeEmailDomain(email);
  if (!domain) return { ok: false, reason: "invalid_email" };
  if (isDisposableDomain(domain)) return { ok: false, reason: "disposable", domain };
  if (isFreeProviderDomain(domain)) return { ok: false, reason: "free_provider", domain };
  const mx = await checkMx(domain, deps.resolveMx, deps.timeoutMs);
  if (mx !== "ok") return { ok: false, reason: mx, domain };
  return { ok: true, reason: "ok", domain };
}
