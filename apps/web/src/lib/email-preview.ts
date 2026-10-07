const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Builds the srcDoc for the sandboxed email preview iframe. Emails sent with
 * only a `text` body have no html, so the plain text is escaped and wrapped
 * in a minimal document instead of rendering an empty preview.
 */
export function getEmailPreviewSrcDoc(
  html: string | null | undefined,
  text: string | null | undefined,
): string | null {
  if (html) {
    return html;
  }

  if (text) {
    return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><pre style="margin:0;padding:16px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:#0f172a">${escapeHtml(text)}</pre></body></html>`;
  }

  return null;
}

// No scripts, no network: remote images, fonts and forms in a held email
// must not load (tracking pixels, phishing pages) while an admin reviews it.
const REVIEW_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'";

/**
 * srcDoc for the admin review preview. Use with an iframe `sandbox=""` (no
 * allow-same-origin, no scripts); the CSP also blocks remote resources.
 */
export function getReviewPreviewSrcDoc(
  html: string | null | undefined,
  text: string | null | undefined,
): string | null {
  const doc = getEmailPreviewSrcDoc(html, text);
  if (!doc) return null;
  return `<meta http-equiv="Content-Security-Policy" content="${REVIEW_PREVIEW_CSP}">${doc}`;
}
