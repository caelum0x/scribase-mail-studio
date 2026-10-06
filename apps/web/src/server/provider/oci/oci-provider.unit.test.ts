import { DomainStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/server/logger/log", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { OciEmailProvider, type OciEmailApi } from "./oci-provider";
import type { OciConfig } from "./config";
import { ProviderSendError } from "../types";
import {
  OCI_SPF_RECORD,
  mapDkimLifecycleState,
  mapSuppressionReason,
} from "./mappers";

const config: OciConfig = {
  region: "eu-frankfurt-1",
  compartmentId: "ocid1.compartment.oc1..test",
  tenancy: "ocid1.tenancy.oc1..test",
  user: "ocid1.user.oc1..test",
  fingerprint: "aa:bb",
  privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  passphrase: undefined,
  smtp: {
    host: "smtp.email.eu-frankfurt-1.oci.oraclecloud.com",
    port: 587,
    user: "smtp-user",
    pass: "smtp-pass",
  },
};

type MockedApi = Record<keyof OciEmailApi, ReturnType<typeof vi.fn>>;

function createApi(): MockedApi {
  return {
    createEmailDomain: vi.fn(),
    getEmailDomain: vi.fn(),
    listEmailDomains: vi.fn(),
    deleteEmailDomain: vi.fn(),
    createDkim: vi.fn(),
    getDkim: vi.fn(),
    listDkims: vi.fn(),
    createSender: vi.fn(),
    listSenders: vi.fn(),
    listSuppressions: vi.fn(),
    getSuppression: vi.fn(),
    deleteSuppression: vi.fn(),
    getEmailConfiguration: vi.fn(),
  };
}

function createTransport() {
  return {
    sendMail: vi.fn(),
    verify: vi.fn(),
  };
}

function createProvider(
  api = createApi(),
  transport = createTransport(),
): {
  provider: OciEmailProvider;
  api: ReturnType<typeof createApi>;
  transport: ReturnType<typeof createTransport>;
} {
  const provider = new OciEmailProvider({
    config,
    api: api as unknown as OciEmailApi,
    transport: transport as never,
    sleep: async () => undefined,
  });
  return { provider, api, transport };
}

const baseSend = {
  from: "Acme <hello@acme.test>",
  to: ["user@example.com"],
  subject: "Hi",
  html: "<p>Hi</p>",
  text: "Hi",
  messageId: "em_1@acme.test",
};

describe("OciEmailProvider.sendRawEmail", () => {
  it("returns the message id when SMTP accepts the message", async () => {
    const { provider, transport } = createProvider();
    transport.sendMail.mockResolvedValue({
      messageId: "<em_1@acme.test>",
      accepted: ["user@example.com"],
      rejected: [],
      response: "250 2.0.0 Ok: queued",
    });

    const result = await provider.sendRawEmail({
      ...baseSend,
      headers: { "X-Test": "1" },
      attachments: [{ filename: "a.txt", content: "aGk=" }],
    });

    expect(result).toEqual({
      messageId: "em_1@acme.test",
      accepted: ["user@example.com"],
      rejected: [],
      response: "250 2.0.0 Ok: queued",
    });
    const mail = transport.sendMail.mock.calls[0]![0];
    expect(mail.messageId).toBe("<em_1@acme.test>");
    expect(mail.from).toBe("Acme <hello@acme.test>");
    expect(mail.headers).toEqual({ "X-Test": "1" });
    expect(mail.attachments).toEqual([
      { filename: "a.txt", content: "aGk=", encoding: "base64" },
    ]);
  });

  it("throws a non-retryable error when every recipient is rejected", async () => {
    const { provider, transport } = createProvider();
    transport.sendMail.mockResolvedValue({
      messageId: "<em_1@acme.test>",
      accepted: [],
      rejected: ["user@example.com"],
      response: "550 rejected",
    });

    await expect(provider.sendRawEmail(baseSend)).rejects.toMatchObject({
      name: "ProviderSendError",
      retryable: false,
    });
  });

  it("marks 4xx SMTP failures as retryable", async () => {
    const { provider, transport } = createProvider();
    transport.sendMail.mockRejectedValue(
      Object.assign(new Error("Try again later"), { responseCode: 451 }),
    );

    const error = await provider.sendRawEmail(baseSend).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderSendError);
    expect(error.retryable).toBe(true);
    expect(error.responseCode).toBe(451);
  });

  it("marks 5xx SMTP failures as permanent", async () => {
    const { provider, transport } = createProvider();
    transport.sendMail.mockRejectedValue(
      Object.assign(new Error("Sender not authorized"), { responseCode: 550 }),
    );

    const error = await provider.sendRawEmail(baseSend).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderSendError);
    expect(error.retryable).toBe(false);
  });

  it("marks connection failures as retryable", async () => {
    const { provider, transport } = createProvider();
    transport.sendMail.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" }),
    );

    const error = await provider.sendRawEmail(baseSend).catch((e) => e);
    expect(error.retryable).toBe(true);
  });

  it("does not leak SMTP credentials in error messages", async () => {
    const { provider, transport } = createProvider();
    transport.sendMail.mockRejectedValue(
      Object.assign(new Error("Invalid login smtp-pass"), {
        responseCode: 535,
      }),
    );

    const error = await provider.sendRawEmail(baseSend).catch((e) => e);
    expect(error.message).not.toContain("smtp-pass");
  });
});

describe("OciEmailProvider.addDomain", () => {
  it("creates the email domain and DKIM and maps the CNAME record", async () => {
    const { provider, api } = createProvider();
    api.createEmailDomain.mockResolvedValue({
      emailDomain: { id: "ocid1.emaildomain.1", name: "acme.test" },
    });
    api.getEmailDomain.mockResolvedValue({
      emailDomain: {
        id: "ocid1.emaildomain.1",
        name: "acme.test",
        lifecycleState: "ACTIVE",
      },
    });
    api.listDkims.mockResolvedValue({ dkimCollection: { items: [] } });
    api.createDkim.mockResolvedValue({
      dkim: {
        id: "ocid1.dkim.1",
        name: "scribase-20261007",
        emailDomainId: "ocid1.emaildomain.1",
        lifecycleState: "CREATING",
        dnsSubdomainName: "scribase-20261007._domainkey.acme.test",
        cnameRecordValue:
          "scribase-20261007.acme.test.dkim.fra1.oracleemaildelivery.com",
      },
    });

    const result = await provider.addDomain("acme.test", {
      dkimSelector: "scribase-20261007",
    });

    expect(api.createEmailDomain).toHaveBeenCalledWith({
      createEmailDomainDetails: expect.objectContaining({
        name: "acme.test",
        compartmentId: config.compartmentId,
      }),
    });
    expect(api.createDkim).toHaveBeenCalledWith({
      createDkimDetails: expect.objectContaining({
        name: "scribase-20261007",
        emailDomainId: "ocid1.emaildomain.1",
      }),
    });
    expect(result).toEqual({
      providerDomainId: "ocid1.emaildomain.1",
      dkim: {
        dkimId: "ocid1.dkim.1",
        selector: "scribase-20261007",
        recordName: "scribase-20261007._domainkey.acme.test",
        recordValue:
          "scribase-20261007.acme.test.dkim.fra1.oracleemaildelivery.com",
      },
    });
  });

  it("reuses an existing email domain and DKIM when the domain already exists", async () => {
    const { provider, api } = createProvider();
    api.createEmailDomain.mockRejectedValue(
      Object.assign(new Error("Conflict"), { statusCode: 409 }),
    );
    api.listEmailDomains.mockResolvedValue({
      emailDomainCollection: {
        items: [{ id: "ocid1.emaildomain.9", name: "acme.test" }],
      },
    });
    api.getEmailDomain.mockResolvedValue({
      emailDomain: { id: "ocid1.emaildomain.9", lifecycleState: "ACTIVE" },
    });
    api.listDkims.mockResolvedValue({
      dkimCollection: {
        items: [
          {
            id: "ocid1.dkim.9",
            name: "old",
            lifecycleState: "ACTIVE",
          },
        ],
      },
    });
    api.getDkim.mockResolvedValue({
      dkim: {
        id: "ocid1.dkim.9",
        name: "old",
        dnsSubdomainName: "old._domainkey.acme.test",
        cnameRecordValue: "old.acme.test.dkim.fra1.oracleemaildelivery.com",
        lifecycleState: "ACTIVE",
      },
    });

    const result = await provider.addDomain("acme.test", {
      dkimSelector: "new",
    });

    expect(api.createDkim).not.toHaveBeenCalled();
    expect(result.providerDomainId).toBe("ocid1.emaildomain.9");
    expect(result.dkim).toEqual({
      dkimId: "ocid1.dkim.9",
      selector: "old",
      recordName: "old._domainkey.acme.test",
      recordValue: "old.acme.test.dkim.fra1.oracleemaildelivery.com",
    });
  });

  it("waits for the email domain to become active before creating DKIM", async () => {
    const { provider, api } = createProvider();
    api.createEmailDomain.mockResolvedValue({
      emailDomain: { id: "ocid1.emaildomain.1", lifecycleState: "CREATING" },
    });
    api.getEmailDomain
      .mockResolvedValueOnce({
        emailDomain: { id: "ocid1.emaildomain.1", lifecycleState: "CREATING" },
      })
      .mockResolvedValueOnce({
        emailDomain: { id: "ocid1.emaildomain.1", lifecycleState: "ACTIVE" },
      });
    api.listDkims.mockResolvedValue({ dkimCollection: { items: [] } });
    api.createDkim.mockResolvedValue({
      dkim: { id: "ocid1.dkim.1", name: "sel", lifecycleState: "CREATING" },
    });

    const result = await provider.addDomain("acme.test", {
      dkimSelector: "sel",
    });

    expect(api.getEmailDomain).toHaveBeenCalledTimes(2);
    expect(result.dkim.dkimId).toBe("ocid1.dkim.1");
    expect(result.dkim.recordName).toBe("sel._domainkey.acme.test");
  });
});

describe("OciEmailProvider.getDomainStatus", () => {
  it("maps an active DKIM with SPF to SUCCESS", async () => {
    const { provider, api } = createProvider();
    api.getEmailDomain.mockResolvedValue({
      emailDomain: {
        id: "ocid1.emaildomain.1",
        lifecycleState: "ACTIVE",
        isSpf: true,
        activeDkimId: "ocid1.dkim.1",
      },
    });
    api.getDkim.mockResolvedValue({
      dkim: {
        id: "ocid1.dkim.1",
        name: "sel",
        lifecycleState: "ACTIVE",
        dnsSubdomainName: "sel._domainkey.acme.test",
        cnameRecordValue: "sel.acme.test.dkim.fra1.oracleemaildelivery.com",
      },
    });

    const status = await provider.getDomainStatus({
      name: "acme.test",
      providerDomainId: "ocid1.emaildomain.1",
      dkimId: "ocid1.dkim.1",
    });

    expect(status.status).toBe(DomainStatus.SUCCESS);
    expect(status.dkimStatus).toBe(DomainStatus.SUCCESS);
    expect(status.spfStatus).toBe(DomainStatus.SUCCESS);
    expect(status.errorMessage).toBeNull();
    expect(status.dkim.recordValue).toBe(
      "sel.acme.test.dkim.fra1.oracleemaildelivery.com",
    );
  });

  it("maps NEEDS_ATTENTION DKIM and missing SPF to PENDING", async () => {
    const { provider, api } = createProvider();
    api.getEmailDomain.mockResolvedValue({
      emailDomain: {
        id: "ocid1.emaildomain.1",
        lifecycleState: "ACTIVE",
        isSpf: false,
      },
    });
    api.getDkim.mockResolvedValue({
      dkim: {
        id: "ocid1.dkim.1",
        name: "sel",
        lifecycleState: "NEEDS_ATTENTION",
        lifecycleDetails: "DNS CNAME not found",
      },
    });

    const status = await provider.getDomainStatus({
      name: "acme.test",
      providerDomainId: "ocid1.emaildomain.1",
      dkimId: "ocid1.dkim.1",
    });

    expect(status.status).toBe(DomainStatus.PENDING);
    expect(status.dkimStatus).toBe(DomainStatus.PENDING);
    expect(status.spfStatus).toBe(DomainStatus.PENDING);
    expect(status.errorMessage).toBe("DNS CNAME not found");
  });

  it("creates the DKIM when the domain has none yet", async () => {
    const { provider, api } = createProvider();
    api.getEmailDomain.mockResolvedValue({
      emailDomain: { id: "ocid1.emaildomain.1", lifecycleState: "ACTIVE" },
    });
    api.listDkims.mockResolvedValue({ dkimCollection: { items: [] } });
    api.createDkim.mockResolvedValue({
      dkim: {
        id: "ocid1.dkim.2",
        name: "sel",
        lifecycleState: "CREATING",
        cnameRecordValue: "sel.acme.test.dkim.fra1.oracleemaildelivery.com",
      },
    });

    const status = await provider.getDomainStatus({
      name: "acme.test",
      providerDomainId: "ocid1.emaildomain.1",
      dkimSelector: "sel",
    });

    expect(api.createDkim).toHaveBeenCalledTimes(1);
    expect(status.dkim.dkimId).toBe("ocid1.dkim.2");
    expect(status.status).toBe(DomainStatus.PENDING);
  });

  it("reports FAILED when the email domain is missing", async () => {
    const { provider, api } = createProvider();
    api.getEmailDomain.mockRejectedValue(
      Object.assign(new Error("Not found"), { statusCode: 404 }),
    );
    api.listEmailDomains.mockResolvedValue({
      emailDomainCollection: { items: [] },
    });

    const status = await provider.getDomainStatus({
      name: "acme.test",
      providerDomainId: "ocid1.emaildomain.1",
    });

    expect(status.status).toBe(DomainStatus.FAILED);
    expect(status.errorMessage).toMatch(/not found/i);
  });
});

describe("mappers", () => {
  it("maps every DKIM lifecycle state", () => {
    expect(mapDkimLifecycleState("ACTIVE")).toBe(DomainStatus.SUCCESS);
    expect(mapDkimLifecycleState("CREATING")).toBe(DomainStatus.PENDING);
    expect(mapDkimLifecycleState("UPDATING")).toBe(DomainStatus.PENDING);
    expect(mapDkimLifecycleState("NEEDS_ATTENTION")).toBe(DomainStatus.PENDING);
    expect(mapDkimLifecycleState("FAILED")).toBe(DomainStatus.FAILED);
    expect(mapDkimLifecycleState("INACTIVE")).toBe(
      DomainStatus.TEMPORARY_FAILURE,
    );
    expect(mapDkimLifecycleState("DELETED")).toBe(DomainStatus.FAILED);
    expect(mapDkimLifecycleState(undefined)).toBe(DomainStatus.NOT_STARTED);
  });

  it("maps suppression reasons", () => {
    expect(mapSuppressionReason("HARDBOUNCE")).toBe("HARD_BOUNCE");
    expect(mapSuppressionReason("SOFTBOUNCE")).toBe("SOFT_BOUNCE");
    expect(mapSuppressionReason("COMPLAINT")).toBe("COMPLAINT");
    expect(mapSuppressionReason("MANUAL")).toBe("MANUAL");
    expect(mapSuppressionReason("UNSUBSCRIBE")).toBe("UNSUBSCRIBE");
    expect(mapSuppressionReason("SOMETHING_NEW")).toBe("UNKNOWN");
    expect(mapSuppressionReason(undefined)).toBe("UNKNOWN");
  });

  it("exposes the OCI SPF record", () => {
    expect(OCI_SPF_RECORD).toBe(
      "v=spf1 include:rp.oracleemaildelivery.com ~all",
    );
  });
});

describe("OciEmailProvider approved senders", () => {
  let api: ReturnType<typeof createApi>;
  let provider: OciEmailProvider;

  beforeEach(() => {
    ({ api, provider } = createProvider());
  });

  it("creates an approved sender when none exists", async () => {
    api.listSenders.mockResolvedValue({ items: [] });
    api.createSender.mockResolvedValue({
      sender: { id: "ocid1.sender.1", emailAddress: "hello@acme.test" },
    });

    const result = await provider.ensureApprovedSender(
      "Acme <Hello@Acme.test>",
    );

    expect(result).toEqual({ created: true });
    expect(api.createSender).toHaveBeenCalledWith({
      createSenderDetails: {
        compartmentId: config.compartmentId,
        emailAddress: "hello@acme.test",
      },
    });
  });

  it("does not create a sender that already exists and caches the lookup", async () => {
    api.listSenders.mockResolvedValue({
      items: [
        {
          id: "ocid1.sender.1",
          emailAddress: "hello@acme.test",
          lifecycleState: "ACTIVE",
        },
      ],
    });

    await provider.ensureApprovedSender("hello@acme.test");
    await provider.ensureApprovedSender("hello@acme.test");

    expect(api.createSender).not.toHaveBeenCalled();
    expect(api.listSenders).toHaveBeenCalledTimes(1);
  });

  it("treats a 409 on create as already approved", async () => {
    api.listSenders.mockResolvedValue({ items: [] });
    api.createSender.mockRejectedValue(
      Object.assign(new Error("Conflict"), { statusCode: 409 }),
    );

    await expect(
      provider.ensureApprovedSender("hello@acme.test"),
    ).resolves.toEqual({ created: false });
  });
});

describe("OciEmailProvider suppressions", () => {
  it("lists all pages of suppressions since a date", async () => {
    const { provider, api } = createProvider();
    api.listSuppressions
      .mockResolvedValueOnce({
        items: [
          {
            id: "s1",
            emailAddress: "a@example.com",
            reason: "HARDBOUNCE",
            timeCreated: new Date("2026-10-07T10:00:00Z"),
          },
        ],
        opcNextPage: "page-2",
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "s2",
            emailAddress: "b@example.com",
            reason: "COMPLAINT",
            timeCreated: new Date("2026-10-07T11:00:00Z"),
          },
        ],
      });

    const since = new Date("2026-10-07T09:00:00Z");
    const result = await provider.listSuppressions(since);

    expect(api.listSuppressions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        compartmentId: config.compartmentId,
        timeCreatedGreaterThanOrEqualTo: "2026-10-07T09:00:00Z",
      }),
    );
    expect(api.listSuppressions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: "page-2" }),
    );
    expect(result).toEqual([
      {
        id: "s1",
        email: "a@example.com",
        reason: "HARD_BOUNCE",
        createdAt: new Date("2026-10-07T10:00:00Z"),
      },
      {
        id: "s2",
        email: "b@example.com",
        reason: "COMPLAINT",
        createdAt: new Date("2026-10-07T11:00:00Z"),
      },
    ]);
  });

  it("maps suppression details", async () => {
    const { provider, api } = createProvider();
    api.getSuppression.mockResolvedValue({
      suppression: {
        id: "s1",
        emailAddress: "a@example.com",
        reason: "HARDBOUNCE",
        timeCreated: new Date("2026-10-07T10:00:00Z"),
        timeLastSuppressed: new Date("2026-10-07T10:05:00Z"),
        messageId: "em_1@acme.test",
        errorDetail: "550 5.1.1 user unknown",
        errorSource: "mx.example.com",
      },
    });

    await expect(provider.getSuppression("s1")).resolves.toEqual({
      id: "s1",
      email: "a@example.com",
      reason: "HARD_BOUNCE",
      createdAt: new Date("2026-10-07T10:00:00Z"),
      lastSuppressedAt: new Date("2026-10-07T10:05:00Z"),
      messageId: "em_1@acme.test",
      errorDetail: "550 5.1.1 user unknown",
      errorSource: "mx.example.com",
    });
  });

  it("deletes every provider suppression entry for an address", async () => {
    const { provider, api } = createProvider();
    api.listSuppressions.mockResolvedValue({
      items: [
        { id: "s1", emailAddress: "a@example.com" },
        { id: "s2", emailAddress: "a@example.com" },
      ],
    });
    api.deleteSuppression.mockResolvedValue({});

    await expect(provider.deleteSuppression("A@example.com ")).resolves.toBe(
      true,
    );
    expect(api.listSuppressions).toHaveBeenCalledWith(
      expect.objectContaining({ emailAddress: "a@example.com" }),
    );
    expect(api.deleteSuppression).toHaveBeenCalledTimes(2);
  });

  it("returns false when deleting a provider suppression fails", async () => {
    const { provider, api } = createProvider();
    api.listSuppressions.mockResolvedValue({
      items: [{ id: "s1", emailAddress: "a@example.com" }],
    });
    api.deleteSuppression.mockRejectedValue(new Error("boom"));

    await expect(provider.deleteSuppression("a@example.com")).resolves.toBe(
      false,
    );
  });
});

describe("OciEmailProvider.getStatus", () => {
  it("reports SMTP and API reachability", async () => {
    const { provider, api, transport } = createProvider();
    transport.verify.mockResolvedValue(true);
    api.getEmailConfiguration.mockResolvedValue({
      configuration: {
        smtpSubmitEndpoint: "smtp.email.eu-frankfurt-1.oci.oraclecloud.com",
      },
    });

    const status = await provider.getStatus();

    expect(status).toMatchObject({
      provider: "oci",
      region: "eu-frankfurt-1",
      smtpConfigured: true,
      apiConfigured: true,
      smtpReachable: true,
      apiReachable: true,
      smtpSubmitEndpoint: "smtp.email.eu-frankfurt-1.oci.oraclecloud.com",
      errors: [],
    });
  });

  it("reports errors without throwing", async () => {
    const { provider, api, transport } = createProvider();
    transport.verify.mockRejectedValue(new Error("auth failed"));
    api.getEmailConfiguration.mockRejectedValue(new Error("401"));

    const status = await provider.getStatus();

    expect(status.smtpReachable).toBe(false);
    expect(status.apiReachable).toBe(false);
    expect(status.errors).toHaveLength(2);
  });
});
