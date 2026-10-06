import { createHmac, timingSafeEqual } from "crypto";

/**
 * Open and click tracking implemented by Scribase Mail itself (the provider
 * has no engagement events). Links are rewritten to a signed redirect and a
 * signed 1x1 pixel is appended to the HTML body.
 */

export type TrackingOptions = {
  emailId: string;
  baseUrl: string;
  secret: string;
};

export type ApplyTrackingOptions = TrackingOptions & {
  open: boolean;
  click: boolean;
};

const SIGNATURE_LENGTH = 32;
const ANCHOR_HREF_PATTERN = /<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>/gi;
const NO_TRACK_ATTRIBUTE = "data-scribase-no-track";

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(value)
    .digest("base64url")
    .slice(0, SIGNATURE_LENGTH);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function buildOpenPixelUrl({
  emailId,
  baseUrl,
  secret,
}: TrackingOptions): string {
  const sig = sign(`open:${emailId}`, secret);
  return `${trimBase(baseUrl)}/api/t/o/${encodeURIComponent(emailId)}?s=${sig}`;
}

export function buildClickUrl(
  { emailId, baseUrl, secret }: TrackingOptions,
  destination: string,
): string {
  const sig = sign(`click:${emailId}\n${destination}`, secret);
  return `${trimBase(baseUrl)}/api/t/c/${encodeURIComponent(emailId)}?u=${encodeURIComponent(destination)}&s=${sig}`;
}

export function verifyOpenSignature(
  emailId: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  return safeEqual(sign(`open:${emailId}`, secret), signature);
}

export function verifyClickSignature(
  emailId: string,
  destination: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  return safeEqual(sign(`click:${emailId}\n${destination}`, secret), signature);
}

export function isSafeRedirectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function rewriteLinks(html: string, options: TrackingOptions): string {
  const unsubscribePrefix = `${trimBase(options.baseUrl)}/unsubscribe`;

  return html.replace(
    ANCHOR_HREF_PATTERN,
    (match, before: string, quote: string, rawHref: string, after: string) => {
      if (`${before} ${after}`.includes(NO_TRACK_ATTRIBUTE)) {
        return match;
      }

      const href = decodeHtmlEntities(rawHref.trim());
      if (!/^https?:\/\//i.test(href) || href.startsWith(unsubscribePrefix)) {
        return match;
      }

      const tracked = escapeAttribute(buildClickUrl(options, href));
      return `<a${before}href=${quote}${tracked}${quote}${after}>`;
    },
  );
}

function appendPixel(html: string, options: TrackingOptions): string {
  const pixel = `<img src="${escapeAttribute(buildOpenPixelUrl(options))}" width="1" height="1" alt="" style="display:none;border:0;width:1px;height:1px" />`;
  const bodyClose = html.search(/<\/body>/i);
  if (bodyClose === -1) {
    return `${html}${pixel}`;
  }
  return `${html.slice(0, bodyClose)}${pixel}${html.slice(bodyClose)}`;
}

export function applyTracking(
  html: string,
  options: ApplyTrackingOptions,
): string {
  let result = html;
  if (options.click) {
    result = rewriteLinks(result, options);
  }
  if (options.open) {
    result = appendPixel(result, options);
  }
  return result;
}
