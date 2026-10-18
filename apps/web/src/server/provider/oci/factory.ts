import nodemailer from "nodemailer";
import { EmailClient } from "oci-email";
import { LoggingManagementClient } from "oci-logging";
import { LogSearchClient } from "oci-loggingsearch";
import { Region, SimpleAuthenticationDetailsProvider } from "oci-common";
import {
  isOciApiConfigured,
  isSmtpConfigured,
  readOciConfig,
  type OciConfig,
  type OciEnv,
} from "./config";
import {
  OciEmailProvider,
  type OciEmailApi,
  type SmtpTransport,
} from "./oci-provider";
import type { OciLogSearchApi, OciLoggingApi } from "./delivery-logs";

const SMTP_POOL_MAX_CONNECTIONS = 5;

export function createOciAuthProvider(config: OciConfig) {
  if (!isOciApiConfigured(config)) {
    return null;
  }

  return new SimpleAuthenticationDetailsProvider(
    config.tenancy!,
    config.user!,
    config.fingerprint!,
    config.privateKey!,
    config.passphrase ?? null,
    Region.fromRegionId(config.region),
  );
}

export function createOciEmailApi(config: OciConfig): OciEmailApi | null {
  const authenticationDetailsProvider = createOciAuthProvider(config);
  if (!authenticationDetailsProvider) {
    return null;
  }

  const client = new EmailClient({ authenticationDetailsProvider });
  client.regionId = config.region;
  return client;
}

export function createOciLoggingApis(config: OciConfig): {
  logging: OciLoggingApi | null;
  logSearch: OciLogSearchApi | null;
} {
  const authenticationDetailsProvider = createOciAuthProvider(config);
  if (!authenticationDetailsProvider) {
    return { logging: null, logSearch: null };
  }

  const logging = new LoggingManagementClient({
    authenticationDetailsProvider,
  });
  logging.regionId = config.region;
  const logSearch = new LogSearchClient({ authenticationDetailsProvider });
  logSearch.regionId = config.region;
  return { logging, logSearch };
}

export type SmtpTransportCredentials = {
  host: string;
  port: number;
  user: string;
  pass: string;
};

/** Shared SMTP transport settings for both the default relay and any
 * dedicated sending pool: 465 = implicit TLS, 587/25 = STARTTLS (required). */
export function createSmtpTransportFromCredentials(
  creds: SmtpTransportCredentials,
): SmtpTransport {
  const { host, port, user, pass } = creds;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
    pool: true,
    maxConnections: SMTP_POOL_MAX_CONNECTIONS,
  });
}

export function createSmtpTransport(config: OciConfig): SmtpTransport | null {
  if (!isSmtpConfigured(config)) {
    return null;
  }

  // isSmtpConfigured already verified these are truthy; narrow explicitly
  // rather than asserting, since it only checks booleans, not types.
  const { host, port, user, pass } = config.smtp;
  if (!host || !user || !pass) {
    return null;
  }

  return createSmtpTransportFromCredentials({ host, port, user, pass });
}

export function createOciProviderFromEnv(env: OciEnv) {
  const config = readOciConfig(env);
  return new OciEmailProvider({
    config,
    api: createOciEmailApi(config),
    transport: createSmtpTransport(config),
    createPoolTransport: createSmtpTransportFromCredentials,
    ...createOciLoggingApis(config),
  });
}
