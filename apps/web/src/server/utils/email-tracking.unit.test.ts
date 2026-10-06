import { describe, expect, it } from "vitest";
import {
  applyTracking,
  buildClickUrl,
  buildOpenPixelUrl,
  isSafeRedirectUrl,
  verifyClickSignature,
  verifyOpenSignature,
} from "./email-tracking";

const opts = {
  emailId: "em_1",
  baseUrl: "https://mail.scribase.com",
  secret: "test-secret",
};

describe("email tracking", () => {
  it("signs open pixel urls", () => {
    const url = new URL(buildOpenPixelUrl(opts));
    expect(url.pathname).toBe("/api/t/o/em_1");
    const sig = url.searchParams.get("s")!;
    expect(verifyOpenSignature("em_1", sig, opts.secret)).toBe(true);
    expect(verifyOpenSignature("em_2", sig, opts.secret)).toBe(false);
    expect(verifyOpenSignature("em_1", sig, "other-secret")).toBe(false);
  });

  it("signs click urls bound to the destination", () => {
    const url = new URL(buildClickUrl(opts, "https://example.com/a?b=1"));
    expect(url.pathname).toBe("/api/t/c/em_1");
    expect(url.searchParams.get("u")).toBe("https://example.com/a?b=1");
    const sig = url.searchParams.get("s")!;
    expect(
      verifyClickSignature(
        "em_1",
        "https://example.com/a?b=1",
        sig,
        opts.secret,
      ),
    ).toBe(true);
    expect(
      verifyClickSignature("em_1", "https://evil.example/", sig, opts.secret),
    ).toBe(false);
    expect(verifyClickSignature("em_1", "x", "", opts.secret)).toBe(false);
  });

  it("rewrites http links and appends the pixel", () => {
    const html =
      '<html><body><a href="https://example.com/x">x</a> <a href=\'http://example.com/y\'>y</a> <a href="mailto:a@b.c">m</a> <a href="#top">t</a></body></html>';

    const result = applyTracking(html, { ...opts, open: true, click: true });

    expect(result).toContain("/api/t/c/em_1?u=https%3A%2F%2Fexample.com%2Fx");
    expect(result).toContain("/api/t/c/em_1?u=http%3A%2F%2Fexample.com%2Fy");
    expect(result).toContain('href="mailto:a@b.c"');
    expect(result).toContain('href="#top"');
    expect(result).toMatch(
      /<img src="https:\/\/mail\.scribase\.com\/api\/t\/o\/em_1\?s=[^"]+"[^>]*><\/body>/,
    );
  });

  it("does not rewrite unsubscribe links or links opted out", () => {
    const html =
      '<a href="https://mail.scribase.com/unsubscribe?id=1">u</a><a data-scribase-no-track href="https://example.com">n</a>';

    const result = applyTracking(html, { ...opts, open: false, click: true });

    expect(result).toContain(
      'href="https://mail.scribase.com/unsubscribe?id=1"',
    );
    expect(result).toContain('href="https://example.com"');
    expect(result).not.toContain("/api/t/o/");
  });

  it("decodes html entities in hrefs before signing", () => {
    const html = '<a href="https://example.com/?a=1&amp;b=2">x</a>';
    const result = applyTracking(html, { ...opts, open: false, click: true });
    expect(result).toContain(
      encodeURIComponent("https://example.com/?a=1&b=2"),
    );
  });

  it("returns html unchanged when tracking is disabled", () => {
    const html = '<a href="https://example.com">x</a>';
    expect(applyTracking(html, { ...opts, open: false, click: false })).toBe(
      html,
    );
  });

  it("only allows http(s) redirects", () => {
    expect(isSafeRedirectUrl("https://example.com")).toBe(true);
    expect(isSafeRedirectUrl("http://example.com")).toBe(true);
    expect(isSafeRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirectUrl("data:text/html,hi")).toBe(false);
    expect(isSafeRedirectUrl("not a url")).toBe(false);
  });
});
