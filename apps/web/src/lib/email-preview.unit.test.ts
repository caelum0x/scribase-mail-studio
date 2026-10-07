import { describe, expect, it } from "vitest";

import { getEmailPreviewSrcDoc, getReviewPreviewSrcDoc } from "./email-preview";

describe("getEmailPreviewSrcDoc", () => {
  it("returns the html body unchanged when present", () => {
    const html = "<html><body><h1>Hello</h1></body></html>";
    expect(getEmailPreviewSrcDoc(html, "ignored text")).toBe(html);
  });

  it("wraps a text-only body in a plain-text document", () => {
    const srcDoc = getEmailPreviewSrcDoc(null, "Hello\n\nworld");
    expect(srcDoc).toContain("<pre");
    expect(srcDoc).toContain("Hello\n\nworld");
  });

  it("escapes html inside a text body instead of rendering it", () => {
    const srcDoc = getEmailPreviewSrcDoc(null, 'Use <b> & "quotes" wisely');
    expect(srcDoc).not.toContain("<b>");
    expect(srcDoc).toContain("&lt;b&gt; &amp; &quot;quotes&quot; wisely");
  });

  it("treats an empty html string as absent and falls back to text", () => {
    const srcDoc = getEmailPreviewSrcDoc("", "plain body");
    expect(srcDoc).toContain("plain body");
    expect(srcDoc).toContain("<pre");
  });

  it("returns null when neither html nor text is present", () => {
    expect(getEmailPreviewSrcDoc(null, null)).toBeNull();
    expect(getEmailPreviewSrcDoc("", "")).toBeNull();
    expect(getEmailPreviewSrcDoc(undefined, undefined)).toBeNull();
  });
});

describe("getReviewPreviewSrcDoc", () => {
  it("prepends a CSP that blocks scripts and remote loads", () => {
    const srcDoc = getReviewPreviewSrcDoc(
      '<img src="https://tracker.test/p.gif"><script>alert(1)</script>',
      null,
    );
    expect(
      srcDoc?.startsWith('<meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
    expect(srcDoc).toContain("default-src 'none'");
    expect(srcDoc).toContain("img-src data:");
  });

  it("returns null without content", () => {
    expect(getReviewPreviewSrcDoc(null, null)).toBeNull();
  });
});
