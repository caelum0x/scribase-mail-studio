import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateTransport } = vi.hoisted(() => ({
  mockCreateTransport: vi.fn(() => ({ sendMail: vi.fn(), verify: vi.fn() })),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mockCreateTransport },
}));

import {
  createGenericSmtpProviderFromEnv,
  createGenericSmtpTransportFromCredentials,
  readSmtpConfig,
} from "./factory";

describe("createGenericSmtpTransportFromCredentials (dedicated sending pools)", () => {
  beforeEach(() => {
    mockCreateTransport.mockClear();
  });

  it("creates a STARTTLS pooled transport for a pool's own credentials", () => {
    createGenericSmtpTransportFromCredentials({
      host: "dedicated.example.net",
      port: 587,
      user: "pool-user",
      pass: "pool-pass",
    });

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "dedicated.example.net",
        port: 587,
        secure: false,
        requireTLS: true,
        pool: true,
        auth: { user: "pool-user", pass: "pool-pass" },
      }),
    );
  });

  it("uses implicit TLS on port 465 for a pool too", () => {
    createGenericSmtpTransportFromCredentials({
      host: "dedicated.example.net",
      port: 465,
      user: "pool-user",
      pass: "pool-pass",
    });

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true, requireTLS: false }),
    );
  });
});

describe("readSmtpConfig", () => {
  it("defaults the port to 587 and requireTls to false", () => {
    const config = readSmtpConfig({ SMTP_HOST: "relay.example.net" });
    expect(config.port).toBe(587);
    expect(config.requireTls).toBe(false);
  });
});

describe("createGenericSmtpProviderFromEnv", () => {
  it("wires a pool transport factory into the provider", () => {
    const provider = createGenericSmtpProviderFromEnv(
      { SMTP_HOST: "relay.example.net", SMTP_USER: "u", SMTP_PASS: "p" },
      { getSigningKey: vi.fn() },
    );
    expect(provider.name).toBe("smtp");
  });
});
