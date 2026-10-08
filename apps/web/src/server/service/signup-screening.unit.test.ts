import { describe, expect, it, vi } from "vitest";

import {
  checkMx,
  isDisposableDomain,
  isFreeProviderDomain,
  normalizeEmailDomain,
  screenSignupEmail,
  type ResolveMx,
} from "./signup-screening";

const mxOk: ResolveMx = async () => [{ exchange: "mx1.acme.example", priority: 10 }];
const dnsError = (code: string): ResolveMx => async () => {
  throw Object.assign(new Error(code), { code });
};

describe("normalizeEmailDomain", () => {
  it("lower-cases and strips a trailing dot", () => {
    expect(normalizeEmailDomain("Jane@ACME.Example.")).toBe("acme.example");
  });
  it("converts IDN to punycode", () => {
    expect(normalizeEmailDomain("a@bücher.de")).toBe("xn--bcher-kva.de");
  });
  it.each([
    "", "no-at", "a@", "@acme.com", "a@b@acme.com", "a@localhost",
    "a@[127.0.0.1]", "a@1.2.3.4", "a@-acme.com", "a@acme..com", "a@acme_x.com",
  ])("rejects %s", (email) => {
    expect(normalizeEmailDomain(email)).toBeNull();
  });
  it("rejects null/undefined", () => {
    expect(normalizeEmailDomain(null)).toBeNull();
    expect(normalizeEmailDomain(undefined)).toBeNull();
  });
});

describe("isFreeProviderDomain", () => {
  it.each(["gmail.com", "outlook.com", "hotmail.co.uk", "proton.me", "icloud.com", "mail.ru", "yandex.ru", "aol.com", "zoho.com", "gmx.de"])(
    "blocks %s",
    (d) => expect(isFreeProviderDomain(d)).toBe(true),
  );
  it("blocks subdomains of free providers", () => {
    expect(isFreeProviderDomain("eu.gmail.com")).toBe(true);
  });
  it("blocks brand look-alikes on other TLDs", () => {
    expect(isFreeProviderDomain("gmail.de")).toBe(true);
    expect(isFreeProviderDomain("yahoo.com.ar")).toBe(true);
    expect(isFreeProviderDomain("outlook.jp")).toBe(true);
  });
  it("does not treat a brand label inside a company domain as free", () => {
    expect(isFreeProviderDomain("gmail.com.acme.io")).toBe(false);
    expect(isFreeProviderDomain("acme.com")).toBe(false);
    expect(isFreeProviderDomain("mail.acme.com")).toBe(false);
    expect(isFreeProviderDomain("acme.co.uk")).toBe(false);
  });
});

describe("isDisposableDomain", () => {
  it("blocks known disposable domains and their subdomains", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("x.mailinator.com")).toBe(true);
  });
  it("allows normal domains", () => {
    expect(isDisposableDomain("scribase.com")).toBe(false);
  });
});

describe("checkMx", () => {
  it("ok with a usable MX", async () => {
    expect(await checkMx("acme.example", mxOk)).toBe("ok");
  });
  it("no_mx for null MX (RFC 7505), localhost and IP exchanges", async () => {
    expect(await checkMx("a.example", async () => [{ exchange: "", priority: 0 }])).toBe("no_mx");
    expect(await checkMx("a.example", async () => [{ exchange: ".", priority: 0 }])).toBe("no_mx");
    expect(await checkMx("a.example", async () => [{ exchange: "localhost", priority: 0 }])).toBe("no_mx");
    expect(await checkMx("a.example", async () => [{ exchange: "10.0.0.1", priority: 0 }])).toBe("no_mx");
    expect(await checkMx("a.example", async () => [])).toBe("no_mx");
  });
  it("no_mx for NXDOMAIN / no data", async () => {
    expect(await checkMx("a.example", dnsError("ENOTFOUND"))).toBe("no_mx");
    expect(await checkMx("a.example", dnsError("ENODATA"))).toBe("no_mx");
  });
  it("mx_lookup_failed on other errors and on timeout (fail closed)", async () => {
    expect(await checkMx("a.example", dnsError("ESERVFAIL"))).toBe("mx_lookup_failed");
    vi.useFakeTimers();
    const p = checkMx("a.example", () => new Promise(() => undefined), 1000);
    vi.advanceTimersByTime(1001);
    expect(await p).toBe("mx_lookup_failed");
    vi.useRealTimers();
  });
});

describe("screenSignupEmail", () => {
  it("passes a business domain with MX", async () => {
    expect(await screenSignupEmail("ceo@Acme.Example", { resolveMx: mxOk })).toEqual({
      ok: true, reason: "ok", domain: "acme.example",
    });
  });
  it("rejects free, disposable, no-MX and invalid", async () => {
    expect((await screenSignupEmail("a@gmail.com", { resolveMx: mxOk })).reason).toBe("free_provider");
    expect((await screenSignupEmail("a@mailinator.com", { resolveMx: mxOk })).reason).toBe("disposable");
    expect((await screenSignupEmail("a@acme.example", { resolveMx: dnsError("ENODATA") })).reason).toBe("no_mx");
    expect((await screenSignupEmail("bad", { resolveMx: mxOk })).reason).toBe("invalid_email");
  });
  it("does not query DNS for free providers", async () => {
    const resolveMx = vi.fn(mxOk);
    await screenSignupEmail("a@GMAIL.COM", { resolveMx });
    expect(resolveMx).not.toHaveBeenCalled();
  });
});
