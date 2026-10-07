import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainStatus, type Domain } from "@prisma/client";

const {
  mockDb,
  mockGetDomainStatus,
  mockWebhookEmit,
  mockRedis,
  mockSendMail,
  mockRenderDomainVerificationStatusEmail,
  mockResolveTxt,
  mockAddDomain,
  mockDeleteDomain,
  mockCheckDomainLimit,
  mockEnsureDeliveryLogs,
} = vi.hoisted(() => ({
  mockEnsureDeliveryLogs: vi.fn(async () => ({
    status: "enabled",
    created: [],
  })),
  mockAddDomain: vi.fn(),
  mockDeleteDomain: vi.fn(),
  mockCheckDomainLimit: vi.fn(),
  mockDb: {
    domain: {
      update: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    teamUser: {
      findMany: vi.fn(),
    },
  },
  mockGetDomainStatus: vi.fn(),
  mockWebhookEmit: vi.fn(),
  mockRedis: {
    mget: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  mockSendMail: vi.fn(),
  mockRenderDomainVerificationStatusEmail: vi.fn(),
  mockResolveTxt: vi.fn(),
}));

// eslint-disable-next-line no-unused-vars -- parameter name in type signature
type TxtCallback = (...args: [Error | null, string[][]?]) => void;

function wasLastNotifiedStatusStored() {
  return mockRedis.set.mock.calls.some(
    (call) => call[0] === "domain:verification:last-notified-status:42",
  );
}

vi.mock("dns", () => ({
  default: {
    resolveTxt: mockResolveTxt,
  },
}));

vi.mock("~/server/db", () => ({
  db: mockDb,
}));

vi.mock("~/server/provider", () => ({
  getEmailProvider: () => ({
    spfRecord: "v=spf1 include:rp.oracleemaildelivery.com ~all",
    getDomainStatus: mockGetDomainStatus,
    addDomain: mockAddDomain,
    deleteDomain: mockDeleteDomain,
    ensureDeliveryLogs: mockEnsureDeliveryLogs,
  }),
  getProviderRegion: () => "eu-frankfurt-1",
}));

function providerStatus({
  status,
  dkimStatus,
  spfStatus,
  errorMessage = null,
}: {
  status: DomainStatus;
  dkimStatus: DomainStatus;
  spfStatus: DomainStatus;
  errorMessage?: string | null;
}) {
  return {
    status,
    dkimStatus,
    spfStatus,
    errorMessage,
    checkedAt: new Date("2026-03-09T12:00:00.000Z"),
    providerDomainId: "ocid1.emaildomain.oc1..42",
    dkim: {
      dkimId: "ocid1.dkim.oc1..42",
      selector: "scribase-fran-20260301",
      recordName: "scribase-fran-20260301._domainkey.example.com",
      recordValue:
        "scribase-fran-20260301.example.com.dkim.fra1.oracleemaildelivery.com",
    },
  };
}

vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: {
    emit: mockWebhookEmit,
  },
}));

vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
}));

vi.mock("~/server/mailer", () => ({
  sendMail: mockSendMail,
}));

vi.mock("~/server/service/limit-service", () => ({
  LimitService: { checkDomainLimit: mockCheckDomainLimit },
}));

vi.mock("~/server/email-templates", () => ({
  renderDomainVerificationStatusEmail: mockRenderDomainVerificationStatusEmail,
}));

import {
  DOMAIN_UNVERIFIED_RECHECK_MS,
  DOMAIN_VERIFIED_RECHECK_MS,
  createDomain as createDomainRecord,
  deleteDomain,
  isDomainVerificationDue,
  refreshDomainVerification,
} from "~/server/service/domain-service";

function createDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: 42,
    name: "example.com",
    teamId: 7,
    status: DomainStatus.PENDING,
    region: "eu-frankfurt-1",
    clickTracking: false,
    openTracking: false,
    providerDomainId: "ocid1.emaildomain.oc1..42",
    dkimId: "ocid1.dkim.oc1..42",
    dkimSelector: "scribase-fran-20260301",
    dkimRecordName: "scribase-fran-20260301._domainkey.example.com",
    dkimRecordValue:
      "scribase-fran-20260301.example.com.dkim.fra1.oracleemaildelivery.com",
    dkimStatus: DomainStatus.NOT_STARTED,
    spfDetails: DomainStatus.NOT_STARTED,
    dmarcAdded: false,
    errorMessage: null,
    subdomain: null,
    isVerifying: true,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("domain-service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    mockDb.domain.update.mockReset();
    mockDb.domain.findUnique.mockReset();
    mockDb.teamUser.findMany.mockReset();
    mockGetDomainStatus.mockReset();
    mockWebhookEmit.mockReset();
    mockRedis.mget.mockReset();
    mockRedis.set.mockReset();
    mockRedis.del.mockReset();
    mockSendMail.mockReset();
    mockRenderDomainVerificationStatusEmail.mockReset();
    mockResolveTxt.mockReset();

    mockRenderDomainVerificationStatusEmail.mockResolvedValue(
      "<p>domain status</p>",
    );
    mockRedis.set.mockResolvedValue("OK");
    mockDb.teamUser.findMany.mockResolvedValue([
      { user: { email: "alice@example.com" } },
      { user: { email: "bob@example.com" } },
    ]);
    mockResolveTxt.mockImplementation((_name: string, cb: TxtCallback) => {
      cb(null, [["v=DMARC1; p=none;"]]);
    });
  });

  it("sends success status emails to all team members when a new domain becomes verified", async () => {
    const domain = createDomain();
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockGetDomainStatus.mockResolvedValue(
      providerStatus({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfStatus: DomainStatus.SUCCESS,
      }),
    );
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );

    const result = await refreshDomainVerification(domain);

    expect(mockDb.domain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DomainStatus.SUCCESS,
          isVerifying: false,
          errorMessage: null,
        }),
      }),
    );
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(wasLastNotifiedStatusStored()).toBe(true);
    expect(result.status).toBe(DomainStatus.SUCCESS);
    expect(result.hasEverVerified).toBe(true);
  });

  it("sends one failure email and stops polling on terminal failure", async () => {
    const domain = createDomain();
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockGetDomainStatus.mockResolvedValue(
      providerStatus({
        status: DomainStatus.FAILED,
        dkimStatus: DomainStatus.PENDING,
        spfStatus: DomainStatus.PENDING,
        errorMessage: "MAIL_FROM_DOMAIN_NOT_VERIFIED",
      }),
    );
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.FAILED,
        dkimStatus: DomainStatus.PENDING,
        spfDetails: DomainStatus.PENDING,
        errorMessage: "MAIL_FROM_DOMAIN_NOT_VERIFIED",
        isVerifying: false,
      }),
    );

    const result = await refreshDomainVerification(domain);

    expect(mockDb.domain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DomainStatus.FAILED,
          isVerifying: false,
          errorMessage: "MAIL_FROM_DOMAIN_NOT_VERIFIED",
        }),
      }),
    );
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(DomainStatus.FAILED);
  });

  it("does not resend status emails when the current status was already notified", async () => {
    const domain = createDomain({
      status: DomainStatus.SUCCESS,
      isVerifying: false,
    });
    mockRedis.mget.mockResolvedValue([
      new Date("2026-03-08T12:00:00.000Z").toISOString(),
      DomainStatus.SUCCESS,
      "1",
    ]);
    mockGetDomainStatus.mockResolvedValue(
      providerStatus({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfStatus: DomainStatus.SUCCESS,
      }),
    );
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );

    await refreshDomainVerification(domain);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("does not send status email on first refresh when status is unchanged", async () => {
    const domain = createDomain({
      status: DomainStatus.SUCCESS,
      dkimStatus: DomainStatus.SUCCESS,
      spfDetails: DomainStatus.SUCCESS,
      isVerifying: false,
    });
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockGetDomainStatus.mockResolvedValue(
      providerStatus({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfStatus: DomainStatus.SUCCESS,
      }),
    );
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );

    await refreshDomainVerification(domain);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(wasLastNotifiedStatusStored()).toBe(false);
  });

  it("reserves the notification so concurrent refreshes do not double-send", async () => {
    const domain = createDomain();
    mockRedis.mget.mockResolvedValue([null, null, null]);
    let reservedOnce = false;
    mockRedis.set.mockImplementation(async (key: string) => {
      if (key.includes("notification-lock")) {
        if (reservedOnce) {
          return null;
        }

        reservedOnce = true;
        return "OK";
      }

      return "OK";
    });
    mockGetDomainStatus.mockResolvedValue(
      providerStatus({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfStatus: DomainStatus.SUCCESS,
      }),
    );
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );

    await Promise.all([
      refreshDomainVerification(domain),
      refreshDomainVerification(domain),
    ]);

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockDb.domain.update).toHaveBeenCalledTimes(2);
  });

  it("logs and continues when sending the status email fails", async () => {
    const domain = createDomain();
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockGetDomainStatus.mockResolvedValue(
      providerStatus({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfStatus: DomainStatus.SUCCESS,
      }),
    );
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );
    mockSendMail
      .mockRejectedValueOnce(new Error("mail failed"))
      .mockResolvedValueOnce(undefined);

    const result = await refreshDomainVerification(domain);

    expect(result.status).toBe(DomainStatus.SUCCESS);
    expect(mockDb.domain.update).toHaveBeenCalled();
    expect(wasLastNotifiedStatusStored()).toBe(false);
  });

  it("uses a 6 hour cadence for domains that have never verified", async () => {
    const domain = createDomain({ status: DomainStatus.PENDING });
    mockRedis.mget.mockResolvedValue([
      new Date(
        Date.now() - DOMAIN_UNVERIFIED_RECHECK_MS + 5 * 60 * 1000,
      ).toISOString(),
      null,
      null,
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(false);

    mockRedis.mget.mockResolvedValue([
      new Date(
        Date.now() - DOMAIN_UNVERIFIED_RECHECK_MS - 5 * 60 * 1000,
      ).toISOString(),
      null,
      null,
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(true);
  });

  it("uses a 30 day cadence after a domain has been verified", async () => {
    const domain = createDomain({ status: DomainStatus.FAILED });
    mockRedis.mget.mockResolvedValue([
      new Date(
        Date.now() - DOMAIN_VERIFIED_RECHECK_MS + 5 * 60 * 1000,
      ).toISOString(),
      DomainStatus.SUCCESS,
      "1",
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(false);

    mockRedis.mget.mockResolvedValue([
      new Date(
        Date.now() - DOMAIN_VERIFIED_RECHECK_MS - 5 * 60 * 1000,
      ).toISOString(),
      DomainStatus.SUCCESS,
      "1",
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(true);
  });

  it("stops automatic retries after an initial terminal failure", async () => {
    const domain = createDomain({
      status: DomainStatus.FAILED,
      isVerifying: false,
    });
    mockRedis.mget.mockResolvedValue([
      new Date("2026-03-09T06:00:00.000Z").toISOString(),
      DomainStatus.FAILED,
      null,
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(false);
  });
});

describe("domain-service provider integration", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockAddDomain.mockReset();
    mockDeleteDomain.mockReset();
    mockCheckDomainLimit.mockReset();
    mockDb.domain.create.mockReset();
    mockDb.domain.delete.mockReset();
    mockDb.domain.findUnique.mockReset();
    mockWebhookEmit.mockReset();
    mockRedis.del.mockReset();
    mockCheckDomainLimit.mockResolvedValue({ isLimitReached: false });
    mockRedis.set.mockResolvedValue("OK");
    mockResolveTxt.mockImplementation((_name: string, cb: TxtCallback) => {
      cb(null, [["v=DMARC1; p=none;"]]);
    });
    mockDb.domain.create.mockImplementation(
      async ({ data }: { data: Partial<Domain> }) => createDomain(data),
    );
  });

  it("creates the domain at the provider and stores DKIM details", async () => {
    mockAddDomain.mockResolvedValue({
      providerDomainId: "ocid1.emaildomain.oc1..new",
      dkim: {
        dkimId: "ocid1.dkim.oc1..new",
        selector: "scribase-fran-20261007",
        recordName: "scribase-fran-20261007._domainkey.mail.example.com",
        recordValue:
          "scribase-fran-20261007.mail.example.com.dkim.fra1.oracleemaildelivery.com",
      },
    });

    const result = await createDomainRecord(7, "mail.example.com");

    expect(mockAddDomain).toHaveBeenCalledWith("mail.example.com", {
      dkimSelector: expect.stringMatching(/^scribase-fran-\d{8}$/),
    });
    expect(mockDb.domain.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "mail.example.com",
        subdomain: "mail",
        region: "eu-frankfurt-1",
        providerDomainId: "ocid1.emaildomain.oc1..new",
        dkimId: "ocid1.dkim.oc1..new",
        dkimSelector: "scribase-fran-20261007",
        dkimRecordName: "scribase-fran-20261007._domainkey.mail.example.com",
      }),
    });
    expect(result.dnsRecords).toEqual([
      expect.objectContaining({
        type: "CNAME",
        name: "scribase-fran-20261007._domainkey.mail",
        value:
          "scribase-fran-20261007.mail.example.com.dkim.fra1.oracleemaildelivery.com",
      }),
      expect.objectContaining({
        type: "TXT",
        name: "mail",
        value: "v=spf1 include:rp.oracleemaildelivery.com ~all",
      }),
      expect.objectContaining({
        type: "TXT",
        name: "_dmarc",
        recommended: true,
      }),
    ]);
    expect(mockWebhookEmit).toHaveBeenCalledWith(
      7,
      "domain.created",
      expect.objectContaining({ name: "mail.example.com" }),
      { domainId: 42 },
    );
  });

  it("enables delivery logs for a new domain without failing on errors", async () => {
    mockAddDomain.mockResolvedValue({
      providerDomainId: "ocid1.emaildomain.oc1..new",
      dkim: { dkimId: "ocid1.dkim.oc1..new", selector: "sel" },
    });
    mockEnsureDeliveryLogs.mockClear();
    mockEnsureDeliveryLogs.mockRejectedValueOnce(new Error("403"));

    await expect(
      createDomainRecord(7, "mail.example.com"),
    ).resolves.toMatchObject({ name: "mail.example.com" });
    expect(mockEnsureDeliveryLogs).toHaveBeenCalledWith({
      name: "mail.example.com",
      providerDomainId: "ocid1.emaildomain.oc1..new",
      dkimId: "ocid1.dkim.oc1..new",
      dkimSelector: "sel",
    });
  });

  it("rejects regions other than the provider region", async () => {
    await expect(
      createDomainRecord(7, "example.com", "us-west-2"),
    ).rejects.toThrow(/not available/);
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it("uses @ for the SPF host on an apex domain", async () => {
    mockAddDomain.mockResolvedValue({
      providerDomainId: "ocid1.emaildomain.oc1..apex",
      dkim: { selector: "scribase-fran-20261007" },
    });

    const result = await createDomainRecord(7, "example.com");

    expect(result.dnsRecords[0]).toMatchObject({
      type: "CNAME",
      name: "scribase-fran-20261007._domainkey",
    });
    expect(result.dnsRecords[1]).toMatchObject({ type: "TXT", name: "@" });
  });

  it("deletes the domain at the provider before removing it locally", async () => {
    const domain = createDomain();
    mockDb.domain.findUnique.mockResolvedValue(domain);
    mockDb.domain.delete.mockResolvedValue(domain);
    mockDeleteDomain.mockResolvedValue(true);

    await deleteDomain(42);

    expect(mockDeleteDomain).toHaveBeenCalledWith({
      name: "example.com",
      providerDomainId: "ocid1.emaildomain.oc1..42",
    });
    expect(mockDb.domain.delete).toHaveBeenCalledWith({ where: { id: 42 } });
  });

  it("keeps the local domain when the provider delete fails", async () => {
    mockDb.domain.findUnique.mockResolvedValue(createDomain());
    mockDeleteDomain.mockResolvedValue(false);

    await expect(deleteDomain(42)).rejects.toThrow(/deleting domain/);
    expect(mockDb.domain.delete).not.toHaveBeenCalled();
  });

  it("stores refreshed DKIM records from the provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockDb.domain.update.mockReset();
    mockDb.domain.update.mockResolvedValue(createDomain());
    mockGetDomainStatus.mockResolvedValue(
      providerStatus({
        status: DomainStatus.PENDING,
        dkimStatus: DomainStatus.PENDING,
        spfStatus: DomainStatus.PENDING,
      }),
    );

    await refreshDomainVerification(
      createDomain({ dkimId: null, dkimRecordValue: null }),
    );

    expect(mockGetDomainStatus).toHaveBeenCalledWith({
      name: "example.com",
      providerDomainId: "ocid1.emaildomain.oc1..42",
      dkimId: null,
      dkimSelector: "scribase-fran-20260301",
    });
    expect(mockDb.domain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dkimId: "ocid1.dkim.oc1..42",
          dkimRecordValue:
            "scribase-fran-20260301.example.com.dkim.fra1.oracleemaildelivery.com",
          status: DomainStatus.PENDING,
        }),
      }),
    );
    vi.useRealTimers();
  });

  it("marks SPF verified when the DNS record is present even if the provider lags", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockDb.domain.update.mockReset();
    mockDb.domain.update.mockResolvedValue(createDomain());
    mockResolveTxt.mockImplementation((name: string, cb: TxtCallback) => {
      cb(
        null,
        name === "example.com"
          ? [["v=spf1 include:rp.oracleemaildelivery.com ~all"]]
          : [["v=DMARC1; p=none;"]],
      );
    });
    mockGetDomainStatus.mockResolvedValue(
      providerStatus({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfStatus: DomainStatus.PENDING,
      }),
    );

    await refreshDomainVerification(createDomain());

    expect(mockDb.domain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spfDetails: DomainStatus.SUCCESS,
          isVerifying: false,
        }),
      }),
    );
    vi.useRealTimers();
  });
});
