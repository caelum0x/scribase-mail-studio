import { readFileSync } from "fs";

export const DEFAULT_OCI_REGION = "eu-frankfurt-1";

export type OciSmtpConfig = {
  host: string | undefined;
  port: number;
  user: string | undefined;
  pass: string | undefined;
};

export type OciConfig = {
  region: string;
  compartmentId: string | undefined;
  tenancy: string | undefined;
  user: string | undefined;
  fingerprint: string | undefined;
  privateKey: string | undefined;
  passphrase: string | undefined;
  /** OCI Logging log group holding the Email Delivery service logs. */
  logGroupName?: string;
  smtp: OciSmtpConfig;
};

export type OciEnv = {
  OCI_REGION?: string;
  OCI_COMPARTMENT_ID?: string;
  OCI_TENANCY?: string;
  OCI_USER?: string;
  OCI_FINGERPRINT?: string;
  OCI_PRIVATE_KEY?: string;
  OCI_PRIVATE_KEY_PATH?: string;
  OCI_PRIVATE_KEY_PASSPHRASE?: string;
  OCI_LOG_GROUP_NAME?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string | number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
};

/**
 * Accepts a PEM key either verbatim, with literal "\n" escapes (common in
 * .env files and compose files) or base64 encoded.
 */
export function normalizePrivateKey(raw: string | undefined) {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) {
    return trimmed.replace(/\\n/g, "\n");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) {
      return decoded.trim();
    }
  } catch {
    // fall through
  }

  return trimmed;
}

export function readOciConfig(
  env: OciEnv,
  // eslint-disable-next-line no-unused-vars -- parameter name in type signature
  readFile: (filePath: string) => string = (filePath) =>
    readFileSync(filePath, "utf8"),
): OciConfig {
  const privateKey =
    normalizePrivateKey(env.OCI_PRIVATE_KEY) ??
    (env.OCI_PRIVATE_KEY_PATH
      ? normalizePrivateKey(readFile(env.OCI_PRIVATE_KEY_PATH))
      : undefined);

  const port = Number(env.SMTP_PORT ?? 587);

  return {
    region: env.OCI_REGION || DEFAULT_OCI_REGION,
    // The tenancy (root compartment) is a valid compartment for Email Delivery.
    compartmentId: env.OCI_COMPARTMENT_ID || env.OCI_TENANCY,
    tenancy: env.OCI_TENANCY,
    user: env.OCI_USER,
    fingerprint: env.OCI_FINGERPRINT,
    privateKey,
    passphrase: env.OCI_PRIVATE_KEY_PASSPHRASE || undefined,
    logGroupName: env.OCI_LOG_GROUP_NAME || undefined,
    smtp: {
      host: env.SMTP_HOST,
      port: Number.isFinite(port) && port > 0 ? port : 587,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  };
}

export function isOciApiConfigured(config: OciConfig) {
  return Boolean(
    config.tenancy &&
    config.user &&
    config.fingerprint &&
    config.privateKey &&
    config.compartmentId,
  );
}

export function isSmtpConfigured(config: OciConfig) {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
}
