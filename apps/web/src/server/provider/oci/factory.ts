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

export function createSmtpTransport(config: OciConfig): SmtpTransport | null {
  if (!isSmtpConfigured(config)) {
    return null;
  }

  const { host, port, user, pass } = config.smtp;
  return nodemailer.createTransport({
    host,
    port,
    // 465 = implicit TLS, 587/25 = STARTTLS (required).
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
    pool: true,
    maxConnections: SMTP_POOL_MAX_CONNECTIONS,
  });
}

export function createOciProviderFromEnv(env: OciEnv) {
  const config = readOciConfig(env);
  return new OciEmailProvider({
    config,
    api: createOciEmailApi(config),
    transport: createSmtpTransport(config),
    ...createOciLoggingApis(config),
  });
}
