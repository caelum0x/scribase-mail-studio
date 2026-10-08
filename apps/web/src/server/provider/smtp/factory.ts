import { promises as dns } from "dns";
import nodemailer from "nodemailer";
import {
  DEFAULT_SMTP_SPF_RECORD,
  GenericSmtpProvider,
  type DkimKeyStore,
  type GenericSmtpTransport,
  type SmtpProviderConfig,
} from "./smtp-provider";

const SMTP_POOL_MAX_CONNECTIONS = 5;

export type SmtpEnv = {
  OCI_REGION?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string | number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_SECURE?: string;
  SMTP_REQUIRE_TLS?: string;
  SMTP_SPF_RECORD?: string;
};

function parseBool(value: string | undefined) {
  if (value === undefined || value === "") {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function readSmtpConfig(env: SmtpEnv): SmtpProviderConfig {
  const port = Number(env.SMTP_PORT ?? 587);
  const safePort = Number.isFinite(port) && port > 0 ? port : 587;
  const secure = parseBool(env.SMTP_SECURE) ?? safePort === 465;
  return {
    region: env.OCI_REGION || "eu-frankfurt-1",
    host: env.SMTP_HOST || undefined,
    port: safePort,
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    secure,
    requireTls: parseBool(env.SMTP_REQUIRE_TLS) ?? false,
    spfRecord: env.SMTP_SPF_RECORD || DEFAULT_SMTP_SPF_RECORD,
  };
}

export function createGenericSmtpTransport(
  config: SmtpProviderConfig,
): GenericSmtpTransport | null {
  if (!config.host) {
    return null;
  }
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && config.requireTls,
    ...(config.user && config.pass
      ? { auth: { user: config.user, pass: config.pass } }
      : {}),
    pool: true,
    maxConnections: SMTP_POOL_MAX_CONNECTIONS,
  }) as unknown as GenericSmtpTransport;
}

export function createGenericSmtpProviderFromEnv(
  env: SmtpEnv,
  keyStore: DkimKeyStore,
) {
  const config = readSmtpConfig(env);
  return new GenericSmtpProvider({
    config,
    transport: createGenericSmtpTransport(config),
    keyStore,
    resolveTxt: (name) => dns.resolveTxt(name),
  });
}
