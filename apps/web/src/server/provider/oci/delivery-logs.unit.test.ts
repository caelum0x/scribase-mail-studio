import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  DEFAULT_LOG_GROUP_NAME,
  DeliveryLogsNotConfiguredError,
  OciDeliveryLogs,
  OUTBOUND_RELAYED_TYPE,
  buildDeliveryEventsQuery,
  deliveryLogDisplayName,
  mapSearchResult,
  type OciLogSearchApi,
  type OciLoggingApi,
} from "./delivery-logs";
import { OciEmailProvider, type OciEmailApi } from "./oci-provider";
import type { OciConfig } from "./config";

const COMPARTMENT = "ocid1.compartment.oc1..test";
const EMAIL_DOMAIN = "ocid1.emaildomain.oc1.eu-frankfurt-1.d1";

function createLogging() {
  return {
    listLogGroups: vi.fn(),
    createLogGroup: vi.fn().mockResolvedValue({}),
    listLogs: vi.fn().mockResolvedValue({ items: [] }),
    createLog: vi.fn().mockResolvedValue({}),
  };
}

function createSearch() {
  return { searchLogs: vi.fn() };
}

function createLogs(
  logging: ReturnType<typeof createLogging> | null = createLogging(),
  search: ReturnType<typeof createSearch> | null = createSearch(),
) {
  const logs = new OciDeliveryLogs({
    compartmentId: COMPARTMENT,
    logging: logging as unknown as OciLoggingApi,
    logSearch: search as unknown as OciLogSearchApi,
    sleep: async () => undefined,
    logGroupPollAttempts: 3,
  });
  return { logs, logging: logging!, search: search! };
}

function relayRecord(overrides: Record<string, unknown> = {}) {
  return {
    datetime: 1_791_370_800_000,
    logContent: {
      specversion: "1.0",
      type: OUTBOUND_RELAYED_TYPE,
      source: "acme.test",
      time: "2026-10-07T10:00:00.000Z",
      id: "rec-1",
      oracle: { logid: "ocid1.log.oc1..l1" },
      data: {
        action: "relay",
        messageId: "<em_1@acme.test>",
        sender: "hello@acme.test",
        recipient: "User@Example.com",
        smtpStatus: "250 2.1.5 Recipient ok",
        recipientMailServer: "mx.example.com (192.0.2.10)",
        internalProcessingDurationInMs: 20,
        ...overrides,
      },
    },
  };
}

describe("mapSearchResult", () => {
  it("maps a relay record", () => {
    expect(mapSearchResult(relayRecord())).toEqual({
      id: "rec-1",
      action: "relay",
      timestamp: new Date("2026-10-07T10:00:00.000Z"),
      messageId: "em_1@acme.test",
      recipient: "user@example.com",
      sender: "hello@acme.test",
      domain: "acme.test",
      bounceType: undefined,
      bounceCategory: undefined,
      bounceCode: undefined,
      smtpStatus: "250 2.1.5 Recipient ok",
      message: undefined,
      recipientMailServer: "mx.example.com (192.0.2.10)",
      processingTimeMs: 20,
      reportGeneratedTime: undefined,
    });
  });

  it("maps bounce details and normalizes errorType", () => {
    const hard = mapSearchResult(
      relayRecord({
        action: "bounce",
        errorType: "hard",
        bounceCategory: "bad-mailbox",
        bounceCode: "5.1.1",
        reportGeneratedTime: "2026-10-07T10:05:00.000Z",
      }),
    );
    expect(hard).toMatchObject({
      action: "bounce",
      bounceType: "hard",
      bounceCategory: "bad-mailbox",
      bounceCode: "5.1.1",
      reportGeneratedTime: new Date("2026-10-07T10:05:00.000Z"),
    });
    expect(
      mapSearchResult(
        relayRecord({ action: "bounce", errorType: "Soft bounce" }),
      )?.bounceType,
    ).toBe("soft");
  });

  it("derives a stable id when the record has none", () => {
    const record = relayRecord();
    delete (record.logContent as { id?: string }).id;
    const a = mapSearchResult(record);
    const b = mapSearchResult(record);
    expect(a?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.id).toBe(b?.id);
  });

  it("returns null for non Email Delivery results and marks unknown actions", () => {
    expect(mapSearchResult({ datetime: 1 })).toBeNull();
    expect(mapSearchResult(null)).toBeNull();
    expect(mapSearchResult(relayRecord({ action: "teleport" }))?.action).toBe(
      "unknown",
    );
  });
});

describe("query + naming", () => {
  it("builds the verified Logging Search query", () => {
    expect(buildDeliveryEventsQuery(COMPARTMENT)).toBe(
      `search "${COMPARTMENT}" | type='com.oraclecloud.emaildelivery.emaildomain.outboundrelayed' and (data.action='relay' or data.action='bounce' or data.action='complaint') | sort by datetime asc`,
    );
  });

  it("builds safe log display names", () => {
    expect(deliveryLogDisplayName("Mail.Acme.test", "outboundrelayed")).toBe(
      "mail_acme_test_outboundrelayed",
    );
  });
});

describe("OciDeliveryLogs.ensureForEmailDomain", () => {
  it("creates the log group and both service logs", async () => {
    const { logs, logging } = createLogs();
    logging.listLogGroups
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({
        items: [{ id: "lg1", displayName: DEFAULT_LOG_GROUP_NAME }],
      });

    const result = await logs.ensureForEmailDomain(EMAIL_DOMAIN, "acme.test");

    expect(logging.createLogGroup).toHaveBeenCalledWith({
      createLogGroupDetails: expect.objectContaining({
        compartmentId: COMPARTMENT,
        displayName: "scribase-mail",
      }),
    });
    expect(logging.listLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        logGroupId: "lg1",
        sourceService: "emaildelivery",
        sourceResource: EMAIL_DOMAIN,
      }),
    );
    expect(logging.createLog).toHaveBeenCalledTimes(2);
    expect(logging.createLog).toHaveBeenCalledWith({
      logGroupId: "lg1",
      createLogDetails: {
        displayName: "acme_test_outboundrelayed",
        logType: "SERVICE",
        isEnabled: true,
        configuration: {
          compartmentId: COMPARTMENT,
          source: {
            sourceType: "OCISERVICE",
            service: "emaildelivery",
            resource: EMAIL_DOMAIN,
            category: "outboundrelayed",
          },
        },
      },
    });
    expect(result).toEqual({
      status: "enabled",
      logGroupId: "lg1",
      created: ["outboundrelayed", "outboundaccepted"],
    });
  });

  it("is idempotent: reuses group, skips existing logs, caches", async () => {
    const { logs, logging } = createLogs();
    logging.listLogGroups.mockResolvedValue({
      items: [{ id: "lg1", displayName: DEFAULT_LOG_GROUP_NAME }],
    });
    logging.listLogs.mockResolvedValue({
      items: [
        {
          lifecycleState: "ACTIVE",
          configuration: { source: { category: "outboundrelayed" } },
        },
      ],
    });

    const first = await logs.ensureForEmailDomain(EMAIL_DOMAIN, "acme.test");
    const second = await logs.ensureForEmailDomain(EMAIL_DOMAIN, "acme.test");

    expect(logging.createLogGroup).not.toHaveBeenCalled();
    expect(logging.createLog).toHaveBeenCalledTimes(1);
    expect(first.created).toEqual(["outboundaccepted"]);
    expect(second).toEqual({
      status: "enabled",
      logGroupId: "lg1",
      created: [],
    });
    expect(logging.listLogs).toHaveBeenCalledTimes(1);
    expect(logs.isEnsured(EMAIL_DOMAIN)).toBe(true);
  });

  it("treats 409 conflicts as already existing", async () => {
    const { logs, logging } = createLogs();
    logging.listLogGroups.mockResolvedValue({
      items: [{ id: "lg1", displayName: DEFAULT_LOG_GROUP_NAME }],
    });
    logging.createLog.mockRejectedValue({ statusCode: 409 });

    const result = await logs.ensureForEmailDomain(EMAIL_DOMAIN, "acme.test");
    expect(result).toEqual({
      status: "enabled",
      logGroupId: "lg1",
      created: [],
    });
  });

  it("propagates other errors and does not cache", async () => {
    const { logs, logging } = createLogs();
    logging.listLogGroups.mockResolvedValue({
      items: [{ id: "lg1", displayName: DEFAULT_LOG_GROUP_NAME }],
    });
    logging.createLog.mockRejectedValue({ statusCode: 404 });

    await expect(
      logs.ensureForEmailDomain(EMAIL_DOMAIN, "acme.test"),
    ).rejects.toEqual({ statusCode: 404 });
    expect(logs.isEnsured(EMAIL_DOMAIN)).toBe(false);
  });

  it("fails when the log group never becomes listable", async () => {
    const { logs, logging } = createLogs();
    logging.listLogGroups.mockResolvedValue({ items: [] });

    await expect(
      logs.ensureForEmailDomain(EMAIL_DOMAIN, "acme.test"),
    ).rejects.toThrow("not available yet");
  });

  it("throws a not-configured error without a logging client", async () => {
    const logs = new OciDeliveryLogs({
      compartmentId: COMPARTMENT,
      logging: null,
      logSearch: null,
      sleep: async () => undefined,
    });
    await expect(
      logs.ensureForEmailDomain(EMAIL_DOMAIN, "acme.test"),
    ).rejects.toBeInstanceOf(DeliveryLogsNotConfiguredError);
    await expect(
      logs.listEvents(new Date(), new Date()),
    ).rejects.toBeInstanceOf(DeliveryLogsNotConfiguredError);
  });
});

describe("OciDeliveryLogs.listEvents", () => {
  const since = new Date("2026-10-07T09:50:00Z");
  const until = new Date("2026-10-07T10:01:00Z");

  it("pages through Logging Search results", async () => {
    const { logs, search } = createLogs();
    search.searchLogs
      .mockResolvedValueOnce({
        searchResponse: { results: [{ data: relayRecord() }] },
        opcNextPage: "p2",
      })
      .mockResolvedValueOnce({
        searchResponse: {
          results: [
            {
              data: relayRecord({ action: "complaint", messageId: "em_2@x" }),
            },
            { data: { unrelated: true } },
          ],
        },
      });

    const page = await logs.listEvents(since, until);

    expect(search.searchLogs).toHaveBeenNthCalledWith(1, {
      searchLogsDetails: {
        timeStart: since,
        timeEnd: until,
        searchQuery: buildDeliveryEventsQuery(COMPARTMENT),
        isReturnFieldInfo: false,
      },
      limit: 1000,
      page: undefined,
    });
    expect(search.searchLogs.mock.calls[1]![0].page).toBe("p2");
    expect(page.truncated).toBe(false);
    expect(page.events.map((e) => e.action)).toEqual(["relay", "complaint"]);
  });

  it("reports truncation when the page cap is hit", async () => {
    const { logs, search } = createLogs();
    search.searchLogs.mockResolvedValue({
      searchResponse: { results: [{ data: relayRecord() }] },
      opcNextPage: "more",
    });

    const page = await logs.listEvents(since, until);
    expect(page.truncated).toBe(true);
    expect(search.searchLogs).toHaveBeenCalledTimes(20);
  });
});

describe("OciEmailProvider delivery logs", () => {
  const config: OciConfig = {
    region: "eu-frankfurt-1",
    compartmentId: COMPARTMENT,
    tenancy: "ocid1.tenancy.oc1..test",
    user: "ocid1.user.oc1..test",
    fingerprint: "aa:bb",
    privateKey: "key",
    passphrase: undefined,
    smtp: { host: undefined, port: 587, user: undefined, pass: undefined },
  };

  let api: { getEmailDomain: ReturnType<typeof vi.fn> };
  let logging: ReturnType<typeof createLogging>;
  let provider: OciEmailProvider;

  beforeEach(() => {
    api = { getEmailDomain: vi.fn() };
    logging = createLogging();
    logging.listLogGroups.mockResolvedValue({
      items: [{ id: "lg1", displayName: DEFAULT_LOG_GROUP_NAME }],
    });
    provider = new OciEmailProvider({
      config,
      api: api as unknown as OciEmailApi,
      transport: null,
      logging: logging as unknown as OciLoggingApi,
      logSearch: createSearch() as unknown as OciLogSearchApi,
      sleep: async () => undefined,
    });
  });

  it("returns pending while the email domain is not ACTIVE", async () => {
    api.getEmailDomain.mockResolvedValue({
      emailDomain: { id: EMAIL_DOMAIN, lifecycleState: "CREATING" },
    });

    const result = await provider.ensureDeliveryLogs({
      name: "acme.test",
      providerDomainId: EMAIL_DOMAIN,
    });

    expect(result).toEqual({ status: "pending", created: [] });
    expect(logging.createLog).not.toHaveBeenCalled();
  });

  it("enables logs for an ACTIVE domain and skips the lookup once cached", async () => {
    api.getEmailDomain.mockResolvedValue({
      emailDomain: { id: EMAIL_DOMAIN, lifecycleState: "ACTIVE" },
    });
    const ref = { name: "acme.test", providerDomainId: EMAIL_DOMAIN };

    const first = await provider.ensureDeliveryLogs(ref);
    const second = await provider.ensureDeliveryLogs(ref);

    expect(first.status).toBe("enabled");
    expect(first.created).toHaveLength(2);
    expect(second.created).toEqual([]);
    expect(api.getEmailDomain).toHaveBeenCalledTimes(1);
  });
});
