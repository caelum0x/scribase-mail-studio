import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateTransport, emailClientInstances, authArgs } = vi.hoisted(
  () => ({
    mockCreateTransport: vi.fn(() => ({ sendMail: vi.fn(), verify: vi.fn() })),
    emailClientInstances: [] as Array<{ regionId?: string; params: unknown }>,
    authArgs: [] as unknown[][],
  }),
);

vi.mock("nodemailer", () => ({
  default: { createTransport: mockCreateTransport },
}));

vi.mock("oci-email", () => ({
  EmailClient: class {
    regionId?: string;
    params: unknown;
    constructor(params: unknown) {
      this.params = params;
      emailClientInstances.push(this);
    }
  },
}));

const { loggingClientInstances } = vi.hoisted(() => ({
  loggingClientInstances: [] as Array<{ kind: string; regionId?: string }>,
}));

vi.mock("oci-logging", () => ({
  LoggingManagementClient: class {
    kind = "logging";
    regionId?: string;
    constructor() {
      loggingClientInstances.push(this);
    }
  },
}));

vi.mock("oci-loggingsearch", () => ({
  LogSearchClient: class {
    kind = "search";
    regionId?: string;
    constructor() {
      loggingClientInstances.push(this);
    }
  },
}));

vi.mock("oci-common", () => ({
  Region: { fromRegionId: (id: string) => ({ regionId: id }) },
  SimpleAuthenticationDetailsProvider: class {
    constructor(...args: unknown[]) {
      authArgs.push(args);
    }
  },
}));

vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createOciLoggingApis,
  createOciEmailApi,
  createOciProviderFromEnv,
  createSmtpTransport,
} from "./factory";
import {
  isOciApiConfigured,
  isSmtpConfigured,
  normalizePrivateKey,
  readOciConfig,
} from "./config";

const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";

const fullEnv = {
  OCI_REGION: "eu-frankfurt-1",
  OCI_TENANCY: "ocid1.tenancy.oc1..t",
  OCI_USER: "ocid1.user.oc1..u",
  OCI_FINGERPRINT: "aa:bb",
  OCI_PRIVATE_KEY: PEM.replace(/\n/g, "\\n"),
  SMTP_HOST: "smtp.email.eu-frankfurt-1.oci.oraclecloud.com",
  SMTP_PORT: "587",
  SMTP_USER: "user",
  SMTP_PASS: "pass",
};

describe("readOciConfig", () => {
  it("defaults the compartment to the tenancy and parses the port", () => {
    const config = readOciConfig(fullEnv);
    expect(config.compartmentId).toBe("ocid1.tenancy.oc1..t");
    expect(config.smtp.port).toBe(587);
    expect(config.privateKey).toBe(PEM);
    expect(isOciApiConfigured(config)).toBe(true);
    expect(isSmtpConfigured(config)).toBe(true);
  });

  it("reads the key from a path when no inline key is set", () => {
    const readFile = vi.fn(() => PEM);
    const config = readOciConfig(
      {
        ...fullEnv,
        OCI_PRIVATE_KEY: undefined,
        OCI_PRIVATE_KEY_PATH: "/k.pem",
      },
      readFile,
    );
    expect(readFile).toHaveBeenCalledWith("/k.pem");
    expect(config.privateKey).toBe(PEM);
  });

  it("accepts base64 encoded keys", () => {
    expect(normalizePrivateKey(Buffer.from(PEM).toString("base64"))).toBe(PEM);
  });

  it("defaults the region and reports missing config", () => {
    const config = readOciConfig({});
    expect(config.region).toBe("eu-frankfurt-1");
    expect(isOciApiConfigured(config)).toBe(false);
    expect(isSmtpConfigured(config)).toBe(false);
  });
});

describe("factory", () => {
  beforeEach(() => {
    mockCreateTransport.mockClear();
    emailClientInstances.length = 0;
    authArgs.length = 0;
  });

  it("creates a STARTTLS pooled transport for port 587", () => {
    createSmtpTransport(readOciConfig(fullEnv));
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.email.eu-frankfurt-1.oci.oraclecloud.com",
        port: 587,
        secure: false,
        requireTLS: true,
        pool: true,
        auth: { user: "user", pass: "pass" },
      }),
    );
  });

  it("uses implicit TLS on port 465", () => {
    createSmtpTransport(readOciConfig({ ...fullEnv, SMTP_PORT: "465" }));
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true, requireTLS: false }),
    );
  });

  it("returns null transport and api when not configured", () => {
    const config = readOciConfig({});
    expect(createSmtpTransport(config)).toBeNull();
    expect(createOciEmailApi(config)).toBeNull();
  });

  it("creates the OCI EmailClient for the configured region", () => {
    createOciEmailApi(readOciConfig(fullEnv));
    expect(emailClientInstances).toHaveLength(1);
    expect(emailClientInstances[0]!.regionId).toBe("eu-frankfurt-1");
    expect(authArgs[0]!.slice(0, 5)).toEqual([
      "ocid1.tenancy.oc1..t",
      "ocid1.user.oc1..u",
      "aa:bb",
      PEM,
      null,
    ]);
  });

  it("creates the Logging + Log Search clients only with API credentials", () => {
    loggingClientInstances.length = 0;
    expect(createOciLoggingApis(readOciConfig({}))).toEqual({
      logging: null,
      logSearch: null,
    });

    const apis = createOciLoggingApis(readOciConfig(fullEnv));
    expect(apis.logging).not.toBeNull();
    expect(apis.logSearch).not.toBeNull();
    expect(loggingClientInstances.map((c) => [c.kind, c.regionId])).toEqual([
      ["logging", "eu-frankfurt-1"],
      ["search", "eu-frankfurt-1"],
    ]);
  });

  it("reads OCI_LOG_GROUP_NAME", () => {
    expect(readOciConfig({}).logGroupName).toBeUndefined();
    expect(
      readOciConfig({ OCI_LOG_GROUP_NAME: "mail-logs" }).logGroupName,
    ).toBe("mail-logs");
  });

  it("builds an OCI provider from env", () => {
    const provider = createOciProviderFromEnv(fullEnv);
    expect(provider.name).toBe("oci");
    expect(provider.region).toBe("eu-frankfurt-1");
    expect(provider.spfRecord).toBe(
      "v=spf1 include:rp.oracleemaildelivery.com ~all",
    );
  });
});
