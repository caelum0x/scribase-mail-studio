import { DomainStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ProviderSendError } from "../types";
import {
  GenericSmtpProvider,
  buildDkimTxtValue,
  generateDkimKeyPair,
  isReservedDomain,
  publicKeyFromPrivate,
  type DkimKeyStore,
  type SmtpProviderConfig,
} from "./smtp-provider";
import { readSmtpConfig } from "./factory";
import { candidateDomains } from "./key-store";

const config: SmtpProviderConfig = {
  region: "eu-frankfurt-1",
  host: "smtp.example.net",
  port: 587,
  user: "relay-user",
  pass: "relay-secret",
  secure: false,
  requireTls: false,
  spfRecord: "v=spf1 a mx ~all",
};

const keys = generateDkimKeyPair();

function setup(options?: {
  key?: { domainName: string; selector: string; privateKey: string } | null;
  txt?: Record<string, string[][]>;
}) {
  const transport = {
    sendMail: vi.fn().mockResolvedValue({
      accepted: ["to@acme.com"],
      rejected: [],
      response: "250 OK",
      messageId: "<m1@acme.com>",
    }),
    verify: vi.fn().mockResolvedValue(true),
  };
  const keyStore: DkimKeyStore = {
    getSigningKey: vi.fn().mockResolvedValue(
      options?.key === undefined
        ? { domainName: "acme.com", selector: "sm1", privateKey: keys.privateKey }
        : options.key,
    ),
  };
  const resolveTxt = vi.fn(async (name: string) => {
    const r = options?.txt?.[name];
    if (!r) {
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    }
    return r;
  });
  const provider = new GenericSmtpProvider({
    config,
    transport,
    keyStore,
    resolveTxt,
    generateKeyPair: () => keys,
  });
  return { provider, transport, keyStore, resolveTxt };
}

describe("GenericSmtpProvider", () => {
  it("advertises TXT DKIM records and the configured SPF", () => {
    const { provider } = setup();
    expect(provider.name).toBe("smtp");
    expect(provider.dkimRecordType).toBe("TXT");
    expect(provider.spfRecord).toBe("v=spf1 a mx ~all");
  });

  it("generates a per-domain key and returns a DKIM TXT record", async () => {
    const { provider } = setup();
    const result = await provider.addDomain("acme.com", { dkimSelector: "sm1" });
    expect(result.dkim.recordName).toBe("sm1._domainkey.acme.com");
    expect(result.dkim.recordValue).toBe(buildDkimTxtValue(keys.publicKey));
    expect(result.dkim.privateKey).toBe(keys.privateKey);
  });

  it("signs mail with the From domain key", async () => {
    const { provider, transport, keyStore } = setup();
    const res = await provider.sendRawEmail({
      from: "Acme <hello@acme.com>",
      to: ["to@acme.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      messageId: "m1@acme.com",
    });
    expect(keyStore.getSigningKey).toHaveBeenCalledWith("acme.com");
    const sent = transport.sendMail.mock.calls[0]![0];
    expect(sent.dkim).toEqual({
      domainName: "acme.com",
      keySelector: "sm1",
      privateKey: keys.privateKey,
    });
    expect(sent.messageId).toBe("<m1@acme.com>");
    expect(res.messageId).toBe("m1@acme.com");
  });

  it("sends unsigned when no key exists", async () => {
    const { provider, transport } = setup({ key: null });
    await provider.sendRawEmail({
      from: "noreply@other.org",
      to: ["to@acme.com"],
      subject: "Hi",
      text: "Hi",
      messageId: "m2@other.org",
    });
    expect(transport.sendMail.mock.calls[0]![0].dkim).toBeUndefined();
  });

  it("maps 4xx to retryable and redacts credentials", async () => {
    const { provider, transport } = setup();
    transport.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("451 try later relay-secret"), { responseCode: 451 }),
    );
    const err = await provider
      .sendRawEmail({
        from: "a@acme.com",
        to: ["b@acme.com"],
        subject: "x",
        messageId: "m3@acme.com",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderSendError);
    expect((err as ProviderSendError).retryable).toBe(true);
    expect((err as Error).message).not.toContain("relay-secret");
  });

  it("rejects when every recipient is refused", async () => {
    const { provider, transport } = setup();
    transport.sendMail.mockResolvedValueOnce({ accepted: [], rejected: ["x"], response: "550" });
    await expect(
      provider.sendRawEmail({ from: "a@acme.com", to: ["x"], subject: "x", messageId: "m" }),
    ).rejects.toThrow(/rejected all recipients/);
  });

  it("verifies DKIM and SPF from DNS", async () => {
    const { provider } = setup({
      txt: {
        "sm1._domainkey.acme.com": [["v=DKIM1; k=rsa; ", `p=${keys.publicKey}`]],
        "acme.com": [["v=spf1 a mx ~all"]],
      },
    });
    const status = await provider.getDomainStatus({ name: "acme.com", dkimSelector: "sm1" });
    expect(status.status).toBe(DomainStatus.SUCCESS);
    expect(status.dkimStatus).toBe(DomainStatus.SUCCESS);
    expect(status.spfStatus).toBe(DomainStatus.SUCCESS);
  });

  it("stays pending without records and fails on a mismatched key", async () => {
    const pending = await setup().provider.getDomainStatus({ name: "acme.com", dkimSelector: "sm1" });
    expect(pending.status).toBe(DomainStatus.PENDING);
    expect(pending.spfStatus).toBe(DomainStatus.PENDING);

    const other = generateDkimKeyPair();
    const failed = await setup({
      txt: { "sm1._domainkey.acme.com": [[buildDkimTxtValue(other.publicKey)]] },
    }).provider.getDomainStatus({ name: "acme.com", dkimSelector: "sm1" });
    expect(failed.status).toBe(DomainStatus.FAILED);
  });

  it("does not accept a parent domain key for a subdomain", async () => {
    const { provider } = setup({
      txt: { "sm1._domainkey.mail.acme.com": [[buildDkimTxtValue(keys.publicKey)]] },
    });
    const status = await provider.getDomainStatus({ name: "mail.acme.com", dkimSelector: "sm1" });
    expect(status.status).toBe(DomainStatus.FAILED);
  });

  it("treats only RFC 2606 reserved names as verified without DNS", async () => {
    const { provider, resolveTxt } = setup();
    const status = await provider.getDomainStatus({ name: "acme.test", dkimSelector: "sm1" });
    expect(status.status).toBe(DomainStatus.SUCCESS);
    expect(resolveTxt).not.toHaveBeenCalled();
    expect(isReservedDomain("acme.test")).toBe(true);
    expect(isReservedDomain("test")).toBe(false);
    expect(isReservedDomain("test.com")).toBe(false);
    expect(isReservedDomain("acme.testing")).toBe(false);
  });

  it("reports SMTP reachability", async () => {
    const { provider, transport } = setup();
    expect((await provider.getStatus()).smtpReachable).toBe(true);
    transport.verify.mockRejectedValueOnce(new Error("refused relay-secret"));
    const status = await provider.getStatus();
    expect(status.smtpReachable).toBe(false);
    expect(status.errors.join()).not.toContain("relay-secret");
  });

  it("has no provider-side suppressions or delivery logs", async () => {
    const { provider } = setup();
    expect(await provider.listSuppressions(new Date())).toEqual([]);
    expect(await provider.listDeliveryEvents(new Date(), new Date())).toEqual({ events: [], truncated: false });
  });
});

describe("helpers", () => {
  it("derives the public key from the private key", () => {
    expect(publicKeyFromPrivate(keys.privateKey)).toBe(keys.publicKey);
    expect(publicKeyFromPrivate("garbage")).toBeNull();
  });

  it("lists candidate domains most specific first", () => {
    expect(candidateDomains("a.mail.Acme.com")).toEqual(["a.mail.acme.com", "mail.acme.com", "acme.com"]);
    expect(candidateDomains("com")).toEqual([]);
  });

  it("reads SMTP config with sane defaults", () => {
    expect(readSmtpConfig({ SMTP_HOST: "mailpit", SMTP_PORT: "1025" })).toMatchObject({
      host: "mailpit",
      port: 1025,
      secure: false,
      requireTls: false,
      spfRecord: "v=spf1 a mx ~all",
    });
    expect(readSmtpConfig({ SMTP_HOST: "h", SMTP_PORT: "465" }).secure).toBe(true);
    expect(readSmtpConfig({ SMTP_HOST: "h", SMTP_REQUIRE_TLS: "true" }).requireTls).toBe(true);
  });
});
