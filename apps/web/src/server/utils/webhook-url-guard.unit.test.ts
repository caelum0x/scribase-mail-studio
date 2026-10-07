import { afterEach, describe, expect, it } from "vitest";
import { assertPublicWebhookUrl, WebhookUrlError } from "./webhook-url-guard";

const resolvesTo =
  (...ips: string[]) =>
  async () =>
    ips.map((address) => ({ address }));

describe("assertPublicWebhookUrl", () => {
  afterEach(() => {
    delete process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS;
  });

  it("accepts a public https host", async () => {
    await expect(
      assertPublicWebhookUrl("https://hooks.example.com/x", resolvesTo("93.184.216.34")),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["http://169.254.169.254/opc/v2/instance/", "169.254.169.254"],
    ["http://redis:6379/", "172.18.0.3"],
    ["http://10.0.0.5/", "10.0.0.5"],
    ["http://[::1]:3000/", "::1"],
    ["https://rebind.example.com/", "127.0.0.1"],
  ])("rejects %s", async (url, ip) => {
    await expect(assertPublicWebhookUrl(url, resolvesTo(ip))).rejects.toBeInstanceOf(
      WebhookUrlError,
    );
  });

  it("rejects when any resolved address is private", async () => {
    await expect(
      assertPublicWebhookUrl("https://mixed.example.com/", resolvesTo("93.184.216.34", "10.1.1.1")),
    ).rejects.toBeInstanceOf(WebhookUrlError);
  });

  it("rejects localhost, credentials and non-http schemes without DNS", async () => {
    const noLookup = async () => {
      throw new Error("lookup must not be called");
    };
    for (const url of ["http://localhost:3000/", "https://u:p@example.com/", "ftp://example.com/"]) {
      await expect(assertPublicWebhookUrl(url, noLookup)).rejects.toBeInstanceOf(WebhookUrlError);
    }
  });

  it("rejects hosts that do not resolve", async () => {
    const fail = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicWebhookUrl("https://nope.invalid/", fail)).rejects.toBeInstanceOf(
      WebhookUrlError,
    );
  });

  it("allows hosts listed in WEBHOOK_ALLOWED_PRIVATE_HOSTS", async () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "smail-recv, other";
    await expect(
      assertPublicWebhookUrl("http://smail-recv:8787/", resolvesTo("172.18.0.9")),
    ).resolves.toBeUndefined();
  });
});
