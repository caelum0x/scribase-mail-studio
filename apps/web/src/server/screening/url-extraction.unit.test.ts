import { describe, expect, it } from "vitest";
import {
  expandRedirects,
  extractLinks,
  hostCandidates,
  isIpHost,
  isShortenerHost,
  isTextHrefMismatch,
  registrableDomain,
} from "./url-extraction";

describe("extractLinks", () => {
  it("finds href, src and form action URLs in html", () => {
    const links = extractLinks({
      html: `<a href="https://Example.com/a">Go</a>
        <img src='https://cdn.example.net/x.png'>
        <form action=https://collect.evil.test/post></form>`,
    });
    const hosts = links.map((l) => l.host);
    expect(hosts).toContain("example.com");
    expect(hosts).toContain("cdn.example.net");
    expect(hosts).toContain("collect.evil.test");
    expect(links.find((l) => l.host === "example.com")?.displayText).toBe("Go");
  });

  it("decodes html entities in attribute URLs", () => {
    const links = extractLinks({
      html: `<a href="https://a.test/?x=1&amp;u=https%3A%2F%2Fevil.test%2F">x</a>`,
    });
    expect(links.map((l) => l.host)).toContain("evil.test");
  });

  it("finds bare URLs in text and www. links", () => {
    const links = extractLinks({
      text: "Visit https://shop.example.org/deal now or www.other.test today.",
    });
    expect(links.map((l) => l.host)).toEqual(
      expect.arrayContaining(["shop.example.org", "www.other.test"]),
    );
  });

  it("keeps javascript: and data: links with their scheme", () => {
    const links = extractLinks({
      html: `<a href="javascript:alert(1)">x</a><a href="data:text/html;base64,PGgxPg==">y</a>`,
    });
    expect(links.map((l) => l.scheme)).toEqual(
      expect.arrayContaining(["javascript:", "data:"]),
    );
  });

  it("ignores mailto, tel, cid and fragment links", () => {
    const links = extractLinks({
      html: `<a href="mailto:a@b.test">m</a><a href="tel:123">t</a><img src="cid:logo"><a href="#top">top</a>`,
    });
    expect(links).toHaveLength(0);
  });

  it("unwraps tracking redirects and keeps both the wrapper and the target", () => {
    const links = extractLinks({
      html: `<a href="https://www.google.com/url?q=https://phish.test/login&sa=D">x</a>`,
    });
    const hosts = links.map((l) => l.host);
    expect(hosts).toContain("www.google.com");
    expect(hosts).toContain("phish.test");
  });

  it("dedupes and caps the number of links", () => {
    const html = Array.from(
      { length: 50 },
      (_, i) =>
        `<a href="https://h${i}.test/">x</a><a href="https://h${i}.test/">x</a>`,
    ).join("");
    expect(extractLinks({ html })).toHaveLength(50);
    expect(extractLinks({ html, maxLinks: 10 })).toHaveLength(10);
  });

  it("normalizes numeric IP hosts", () => {
    const links = extractLinks({ text: "http://3232235777/x" });
    expect(links[0]?.host).toBe("192.168.1.1");
  });
});

describe("expandRedirects", () => {
  it("follows nested redirect parameters up to a depth", () => {
    const inner = encodeURIComponent("https://final.test/x");
    const middle = encodeURIComponent(`https://r.test/?url=${inner}`);
    expect(expandRedirects(`https://l.test/?u=${middle}`)).toEqual([
      `https://l.test/?u=${middle}`,
      `https://r.test/?url=${inner}`,
      "https://final.test/x",
    ]);
  });

  it("ignores params that are not URLs", () => {
    expect(expandRedirects("https://a.test/?q=shoes")).toEqual([
      "https://a.test/?q=shoes",
    ]);
  });
});

describe("host helpers", () => {
  it("detects IP hosts", () => {
    expect(isIpHost("10.0.0.1")).toBe(true);
    expect(isIpHost("[::1]")).toBe(true);
    expect(isIpHost("example.com")).toBe(false);
  });

  it("detects URL shorteners including subdomains", () => {
    expect(isShortenerHost("bit.ly")).toBe(true);
    expect(isShortenerHost("www.tinyurl.com")).toBe(true);
    expect(isShortenerHost("example.com")).toBe(false);
  });

  it("computes registrable domains with common two-level suffixes", () => {
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.com.br")).toBe("example.com.br");
  });

  it("lists the host and its parent domains, never a bare suffix", () => {
    expect(hostCandidates("a.b.evil.test")).toEqual([
      "a.b.evil.test",
      "b.evil.test",
      "evil.test",
    ]);
    expect(hostCandidates("www.example.co.uk")).toEqual([
      "www.example.co.uk",
      "example.co.uk",
    ]);
  });
});

describe("isTextHrefMismatch", () => {
  it("flags link text that names another domain", () => {
    expect(
      isTextHrefMismatch("https://www.paypal.com/login", "https://evil.test/x"),
    ).toBe(true);
    expect(isTextHrefMismatch("paypal.com", "https://evil.test/x")).toBe(true);
  });

  it("accepts matching or non-URL text", () => {
    expect(
      isTextHrefMismatch("www.example.com/help", "https://example.com/help"),
    ).toBe(false);
    expect(
      isTextHrefMismatch("app.example.com", "https://links.example.com/x"),
    ).toBe(false);
    expect(isTextHrefMismatch("Click here", "https://evil.test/x")).toBe(false);
    expect(isTextHrefMismatch("v1.2", "https://evil.test/x")).toBe(false);
  });
});
