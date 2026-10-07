/**
 * Pulls every link out of an outgoing email so content screening can check
 * it: anchor/img/form attributes in the html, bare URLs in html and text, and
 * the targets hidden inside redirect/tracking wrappers.
 */

export type ExtractedLink = {
  url: string;
  // Lowercased hostname without a trailing dot; "" for javascript:/data:.
  host: string;
  scheme: string;
  // Visible text of the <a> element the link came from, when there is one.
  displayText?: string;
};

const DEFAULT_MAX_LINKS = 500;
const MAX_REDIRECT_DEPTH = 3;
// Screening looks at the first few MB only; a huge body is itself suspicious
// and is scored elsewhere.
const MAX_SCAN_CHARS = 2_000_000;

// Inner text is bounded so unclosed tags in hostile html can't make the scan quadratic.
const ANCHOR_PATTERN = /<a\b([^>]{0,4000})>([\s\S]{0,4000}?)<\/a\s*>/gi;
const URL_ATTRIBUTE_PATTERN =
  /\b(?:href|src|action|background|poster|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const HREF_ATTRIBUTE_PATTERN =
  /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const BARE_URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`()[\]{}]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

const SKIPPED_SCHEMES = new Set(["mailto:", "tel:", "sms:", "cid:"]);
const FLAGGED_SCHEMES = new Set(["javascript:", "vbscript:", "data:"]);

const REDIRECT_PARAMS = [
  "u",
  "url",
  "q",
  "target",
  "redirect",
  "redirect_url",
  "redirect_uri",
  "dest",
  "destination",
  "link",
  "r",
  "to",
  "goto",
  "next",
];

// Second-level labels that act as public suffixes under a ccTLD (co.uk, com.br).
const SECOND_LEVEL_SUFFIXES = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "edu",
  "ac",
  "gob",
  "or",
  "ne",
  "go",
  "mil",
  "nic",
]);

const COMMON_TLDS = new Set([
  "com",
  "net",
  "org",
  "info",
  "biz",
  "io",
  "co",
  "app",
  "dev",
  "xyz",
  "online",
  "site",
  "shop",
  "store",
  "top",
  "club",
  "live",
  "tech",
  "me",
  "ai",
  "gov",
  "edu",
]);

export const URL_SHORTENER_HOSTS: ReadonlySet<string> = new Set([
  "bit.ly",
  "bitly.com",
  "bit.do",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "v.gd",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "shorturl.com",
  "tiny.cc",
  "rb.gy",
  "t.ly",
  "s.id",
  "bl.ink",
  "short.io",
  "soo.gd",
  "clck.ru",
  "qrco.de",
  "shorte.st",
  "adf.ly",
  "x.co",
  "u.to",
  "tr.im",
  "surl.li",
  "gg.gg",
  "tny.im",
  "kutt.it",
  "did.li",
  "2no.co",
  "iplogger.org",
  "iplogger.com",
  "grabify.link",
  "urlz.fr",
  "po.st",
  "lnkd.in",
  "db.tt",
  "snip.ly",
  "smarturl.it",
  "short.gy",
]);

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&nbsp;/gi, " ");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function parseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  const withScheme = /^www\./i.test(trimmed) ? `http://${trimmed}` : trimmed;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function schemeOf(raw: string): string | null {
  // Browsers ignore whitespace and control characters inside the scheme.
  // eslint-disable-next-line no-control-regex -- control characters are the point
  const compact = raw.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
  const match = /^([a-z][a-z0-9+.-]*):/.exec(compact);
  return match ? `${match[1]}:` : null;
}

/**
 * The URL itself plus every URL hidden in a redirect parameter
 * (?url=, ?q=, ?u=...), outermost first.
 */
export function expandRedirects(url: string): string[] {
  const chain = [url];
  let current = url;
  for (let depth = 0; depth < MAX_REDIRECT_DEPTH; depth++) {
    const parsed = parseUrl(current);
    if (!parsed) break;
    let next: string | undefined;
    for (const param of REDIRECT_PARAMS) {
      const value = parsed.searchParams.get(param);
      if (value && /^https?:\/\//i.test(value.trim())) {
        next = value.trim();
        break;
      }
    }
    if (!next || chain.includes(next)) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

function toLinks(raw: string, displayText?: string): ExtractedLink[] {
  const value = decodeEntities(raw).trim();
  if (!value || value.startsWith("#")) return [];

  const scheme = schemeOf(value);
  if (scheme && SKIPPED_SCHEMES.has(scheme)) return [];
  if (scheme && FLAGGED_SCHEMES.has(scheme)) {
    return [{ url: value.slice(0, 200), host: "", scheme, displayText }];
  }
  if (scheme && scheme !== "http:" && scheme !== "https:") return [];
  if (!scheme && !/^www\./i.test(value) && !value.startsWith("//")) return [];

  const absolute = value.startsWith("//") ? `https:${value}` : value;
  return expandRedirects(absolute).flatMap((url, index) => {
    const parsed = parseUrl(url);
    if (!parsed || !parsed.hostname) return [];
    return [
      {
        url: parsed.href,
        host: normalizeHost(parsed.hostname),
        scheme: parsed.protocol,
        // Only the outer link is what the reader sees next to the text.
        displayText: index === 0 ? displayText : undefined,
      },
    ];
  });
}

export function extractLinks({
  html,
  text,
  maxLinks = DEFAULT_MAX_LINKS,
}: {
  html?: string | null;
  text?: string | null;
  maxLinks?: number;
}): ExtractedLink[] {
  const found: ExtractedLink[] = [];
  const htmlBody = (html ?? "").slice(0, MAX_SCAN_CHARS);
  const textBody = (text ?? "").slice(0, MAX_SCAN_CHARS);

  for (const match of htmlBody.matchAll(ANCHOR_PATTERN)) {
    const href = HREF_ATTRIBUTE_PATTERN.exec(match[1] ?? "");
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    if (value) found.push(...toLinks(value, stripTags(match[2] ?? "")));
  }
  for (const match of htmlBody.matchAll(URL_ATTRIBUTE_PATTERN)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) found.push(...toLinks(value));
  }
  for (const body of [decodeEntities(htmlBody), textBody]) {
    for (const match of body.matchAll(BARE_URL_PATTERN)) {
      found.push(...toLinks(match[0].replace(TRAILING_PUNCTUATION, "")));
    }
  }

  // First occurrence wins so anchor display text is kept.
  const seen = new Set<string>();
  const unique: ExtractedLink[] = [];
  for (const link of found) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    unique.push(link);
    if (unique.length >= maxLinks) break;
  }
  return unique;
}

export function isIpHost(host: string): boolean {
  if (host.startsWith("[")) return true; // IPv6 literal
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function isSuffixPair(labels: string[]): boolean {
  // ["co", "uk"]: short ccTLD with a known second-level label.
  return (
    labels.length === 2 &&
    (labels[1]?.length ?? 0) === 2 &&
    SECOND_LEVEL_SUFFIXES.has(labels[0] ?? "")
  );
}

export function registrableDomain(host: string): string {
  const labels = normalizeHost(host).split(".");
  if (labels.length <= 2) return labels.join(".");
  const take = isSuffixPair(labels.slice(-2)) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** The host followed by each parent domain down to the registrable domain. */
export function hostCandidates(host: string): string[] {
  const normalized = normalizeHost(host);
  if (isIpHost(normalized)) return [normalized];
  const minLabels = registrableDomain(normalized).split(".").length;
  const labels = normalized.split(".");
  const candidates: string[] = [];
  for (let i = 0; labels.length - i >= minLabels; i++) {
    candidates.push(labels.slice(i).join("."));
  }
  return candidates;
}

export function isShortenerHost(host: string): boolean {
  return hostCandidates(host).some((h) => URL_SHORTENER_HOSTS.has(h));
}

function hostFromDisplayText(displayText: string): string | null {
  const value = displayText.trim();
  if (!value || /\s/.test(value)) return null;
  const hasPrefix = /^(?:https?:\/\/|www\.)/i.test(value);
  const parsed = parseUrl(hasPrefix ? value : `http://${value}`);
  if (!parsed || !parsed.hostname.includes(".")) return null;
  const host = normalizeHost(parsed.hostname);
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const tld = host.split(".").pop() ?? "";
  if (hasPrefix) return /^[a-z]{2,}$/.test(tld) ? host : null;
  return COMMON_TLDS.has(tld) || /^[a-z]{2}$/.test(tld) ? host : null;
}

/**
 * True when the visible link text is itself a URL or domain that points
 * somewhere other than the real href (classic phishing trick).
 */
export function isTextHrefMismatch(displayText: string, href: string): boolean {
  const shownHost = hostFromDisplayText(displayText);
  if (!shownHost) return false;
  const parsed = parseUrl(href);
  if (!parsed || !parsed.hostname) return false;
  return (
    registrableDomain(shownHost) !==
    registrableDomain(normalizeHost(parsed.hostname))
  );
}
