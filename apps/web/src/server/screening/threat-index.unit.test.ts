import { describe, expect, it } from "vitest";
import {
  buildHostIndex,
  hashHost,
  parseFeedHosts,
  ThreatIndex,
} from "./threat-index";

describe("parseFeedHosts", () => {
  it("reads plain domains, URLs and hosts-file lines and skips comments", () => {
    const hosts = parseFeedHosts(
      [
        "# comment",
        "! adblock comment",
        "",
        "Evil.Test.",
        "https://phish.example/login?x=1",
        "0.0.0.0 tracker.bad",
        "*.wild.test",
        "not a host",
        "10.1.2.3",
      ].join("\n"),
    );
    expect(hosts).toEqual([
      "evil.test",
      "phish.example",
      "tracker.bad",
      "wild.test",
      "10.1.2.3",
    ]);
  });
});

describe("buildHostIndex / ThreatIndex", () => {
  const index = new ThreatIndex(
    buildHostIndex([
      "evil.test",
      "login.bank.phish",
      "sites.google.com",
      "1.2.3.4",
    ]),
  );

  it("matches exact hosts and subdomains of listed domains", () => {
    expect(index.isListed("evil.test")).toBe(true);
    expect(index.isListed("www.evil.test")).toBe(true);
    expect(index.isListed("a.b.evil.test")).toBe(true);
    expect(index.isListed("login.bank.phish")).toBe(true);
    expect(index.isListed("1.2.3.4")).toBe(true);
  });

  it("does not match parents of a listed subdomain", () => {
    expect(index.isListed("bank.phish")).toBe(false);
    expect(index.isListed("example.com")).toBe(false);
  });

  it("never matches exempt shared-platform hosts", () => {
    expect(index.isListed("sites.google.com")).toBe(false);
  });

  it("honours extra exempt hosts", () => {
    const custom = new ThreatIndex(buildHostIndex(["mine.test"]), [
      "mine.test",
    ]);
    expect(custom.isListed("mine.test")).toBe(false);
  });

  it("dedupes and sorts hashes", () => {
    const built = buildHostIndex(["b.test", "a.test", "b.test"]);
    expect(built.length).toBe(2);
    expect(built[0]! < built[1]!).toBe(true);
  });

  it("hashes case-insensitively", () => {
    expect(hashHost("Evil.TEST")).toBe(hashHost("evil.test"));
  });

  it("an empty index lists nothing", () => {
    expect(ThreatIndex.empty().isListed("evil.test")).toBe(false);
    expect(ThreatIndex.empty().size).toBe(0);
  });
});
