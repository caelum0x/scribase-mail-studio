/* eslint-disable no-unused-vars -- parameter names in type signatures */
import { createPublicKey, generateKeyPairSync } from "crypto";
import { DomainStatus } from "@prisma/client";
import type { SentMessageInfo } from "nodemailer";
import {
  ProviderSendError,
  type ApprovedSender,
  type EmailProvider,
  type ProviderDeliveryEventPage,
  type ProviderDeliveryLogsResult,
  type ProviderDomainRef,
  type ProviderDomainResult,
  type ProviderDomainStatus,
  type ProviderStatus,
  type ProviderSuppressionDetail,
  type ProviderSuppressionSummary,
  type SendRawEmailInput,
  type SendRawEmailResult,
} from "../types";

/**
 * Generic SMTP provider for self-hosting (EMAIL_PROVIDER=smtp).
 *
 * Sends through any SMTP relay (Postfix, Mailpit, a hosted relay), signs
 * DKIM locally with a per-domain RSA key and verifies domains by DNS lookup.
 * Bounces and complaints are tracked locally (webhooks/suppression list);
 * there is no provider-side suppression list or delivery log.
 */

export const DEFAULT_SMTP_SPF_RECORD = "v=spf1 a mx ~all";

/**
 * RFC 2606 / RFC 6761 reserved names. They can never exist in public DNS,
 * so domains under them are treated as verified for local trials.
 */
const RESERVED_TLDS = ["test", "localhost", "example", "invalid"];

const RETRYABLE_SOCKET_CODES = new Set([
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "EHOSTUNREACH",
  "ENOTFOUND",
]);

export type SmtpProviderConfig = {
  region: string;
  host: string | undefined;
  port: number;
  user: string | undefined;
  pass: string | undefined;
  /** Implicit TLS (port 465). */
  secure: boolean;
  /** Require STARTTLS on non-implicit-TLS ports. */
  requireTls: boolean;
  spfRecord: string;
};

export type SmtpSendOptions = Record<string, unknown>;

export type GenericSmtpTransport = {
  sendMail(options: SmtpSendOptions): Promise<SentMessageInfo>;
  verify(): Promise<unknown>;
};

export type DkimSigningKey = {
  domainName: string;
  selector: string;
  privateKey: string;
};

export type DkimKeyStore = {
  /** Signing key for the most specific registered domain of `domainName`. */
  getSigningKey(domainName: string): Promise<DkimSigningKey | null>;
};

export type TxtResolver = (name: string) => Promise<string[][]>;

export type KeyPairGenerator = () => { publicKey: string; privateKey: string };

export function generateDkimKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKey: Buffer.from(publicKey).toString("base64"),
    privateKey,
  };
}

export function buildDkimTxtValue(publicKeyBase64: string) {
  return `v=DKIM1; k=rsa; p=${publicKeyBase64}`;
}

export function isReservedDomain(domain: string) {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  const tld = labels[labels.length - 1] ?? "";
  return labels.length >= 2 && RESERVED_TLDS.includes(tld);
}

function extractDkimPublicKey(value: string) {
  const match = /(?:^|;)\s*p=([A-Za-z0-9+/=\s]*)/.exec(value);
  return match?.[1]?.replace(/\s+/g, "") ?? null;
}

/** Base64 SPKI DER public key for a PEM private key (null when invalid). */
export function publicKeyFromPrivate(privateKeyPem: string) {
  try {
    const der = createPublicKey(privateKeyPem).export({
      type: "spki",
      format: "der",
    });
    return Buffer.from(der).toString("base64");
  } catch {
    return null;
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function stripAngleBrackets(value: string) {
  return value.replace(/^</, "").replace(/>$/, "");
}

function domainOfAddress(address: string) {
  const match = /<([^>]+)>\s*$/.exec(address);
  const email = (match?.[1] ?? address).trim();
  const at = email.lastIndexOf("@");
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

export class GenericSmtpProvider implements EmailProvider {
  readonly name = "smtp" as const;
  readonly dkimRecordType = "TXT" as const;
  readonly region: string;
  readonly spfRecord: string;

  private readonly config: SmtpProviderConfig;
  private readonly transport: GenericSmtpTransport | null;
  private readonly keyStore: DkimKeyStore;
  private readonly resolveTxt: TxtResolver;
  private readonly generateKeyPair: KeyPairGenerator;

  constructor(options: {
    config: SmtpProviderConfig;
    transport: GenericSmtpTransport | null;
    keyStore: DkimKeyStore;
    resolveTxt: TxtResolver;
    generateKeyPair?: KeyPairGenerator;
  }) {
    this.config = options.config;
    this.region = options.config.region;
    this.spfRecord = options.config.spfRecord;
    this.transport = options.transport;
    this.keyStore = options.keyStore;
    this.resolveTxt = options.resolveTxt;
    this.generateKeyPair = options.generateKeyPair ?? generateDkimKeyPair;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async sendRawEmail(input: SendRawEmailInput): Promise<SendRawEmailResult> {
    if (!this.transport) {
      throw new ProviderSendError("SMTP relay is not configured (SMTP_HOST)", {
        retryable: false,
      });
    }

    const fromDomain = domainOfAddress(input.from);
    const key = fromDomain
      ? await this.keyStore.getSigningKey(fromDomain)
      : null;

    let info: SentMessageInfo;
    try {
      info = await this.transport.sendMail({
        from: input.from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        replyTo: input.replyTo,
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers: input.headers,
        messageId: `<${stripAngleBrackets(input.messageId)}>`,
        attachments: input.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          encoding: "base64" as const,
          ...(attachment.cid !== undefined ? { cid: attachment.cid } : {}),
          ...(attachment.contentType !== undefined
            ? { contentType: attachment.contentType }
            : {}),
        })),
        ...(key
          ? {
              dkim: {
                domainName: key.domainName,
                keySelector: key.selector,
                privateKey: key.privateKey,
              },
            }
          : {}),
      });
    } catch (error) {
      throw this.toSendError(error);
    }

    const accepted = ((info?.accepted ?? []) as unknown[]).map(String);
    const rejected = ((info?.rejected ?? []) as unknown[]).map(String);
    const response = typeof info?.response === "string" ? info.response : "";

    if (accepted.length === 0) {
      throw new ProviderSendError(
        `SMTP relay rejected all recipients${response ? `: ${this.redact(response)}` : ""}`,
        { retryable: false },
      );
    }

    return {
      messageId: stripAngleBrackets(
        typeof info?.messageId === "string" ? info.messageId : input.messageId,
      ),
      accepted,
      rejected,
      response: response || undefined,
    };
  }

  private redact(message: string) {
    let result = message;
    for (const secret of [this.config.pass, this.config.user]) {
      if (secret && secret.length >= 4) {
        result = result.split(secret).join("***");
      }
    }
    return result;
  }

  private toSendError(error: unknown) {
    const err = (error ?? {}) as { responseCode?: unknown; code?: unknown };
    const responseCode =
      typeof err.responseCode === "number" ? err.responseCode : undefined;
    const code = typeof err.code === "string" ? err.code : undefined;
    const retryable =
      (responseCode !== undefined &&
        responseCode >= 400 &&
        responseCode < 500) ||
      (responseCode === undefined &&
        code !== undefined &&
        RETRYABLE_SOCKET_CODES.has(code));
    const message =
      responseCode === 535
        ? "SMTP authentication failed. Check SMTP_USER / SMTP_PASS."
        : `SMTP send failed${responseCode ? ` (${responseCode})` : ""}: ${this.redact(errorMessage(error))}`;
    return new ProviderSendError(message, {
      retryable,
      responseCode,
      cause: error,
    });
  }

  // ---------------------------------------------------------------------------
  // Domains + DKIM
  // ---------------------------------------------------------------------------

  async addDomain(
    domain: string,
    options: { dkimSelector: string },
  ): Promise<ProviderDomainResult> {
    const { publicKey, privateKey } = this.generateKeyPair();
    const selector = options.dkimSelector;
    return {
      providerDomainId: `smtp:${domain.toLowerCase()}`,
      dkim: {
        selector,
        recordName: `${selector}._domainkey.${domain}`,
        recordValue: buildDkimTxtValue(publicKey),
        privateKey,
      },
    };
  }

  async deleteDomain(_domain: ProviderDomainRef): Promise<boolean> {
    // Keys are removed with the domain row (ON DELETE CASCADE).
    return true;
  }

  async getDomainStatus(domain: ProviderDomainRef): Promise<ProviderDomainStatus> {
    const checkedAt = new Date();
    const selector = domain.dkimSelector ?? undefined;
    const recordName = selector
      ? `${selector}._domainkey.${domain.name}`
      : undefined;

    if (isReservedDomain(domain.name)) {
      return {
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfStatus: DomainStatus.SUCCESS,
        errorMessage: null,
        checkedAt,
        dkim: { selector, recordName },
      };
    }

    const key = await this.keyStore.getSigningKey(domain.name);
    let dkimStatus: DomainStatus = DomainStatus.PENDING;
    let errorMessageText: string | null = null;

    if (!key || !recordName || key.domainName !== domain.name.toLowerCase()) {
      dkimStatus = DomainStatus.FAILED;
      errorMessageText = "No DKIM key is stored for this domain";
    } else {
      const expected = publicKeyFromPrivate(key.privateKey);
      const published = await this.lookupTxt(recordName);
      const found = published
        .map(extractDkimPublicKey)
        .some((p) => p !== null && expected !== null && p === expected);
      if (found) {
        dkimStatus = DomainStatus.SUCCESS;
      } else if (published.length > 0) {
        dkimStatus = DomainStatus.FAILED;
        errorMessageText = `The TXT record at ${recordName} does not match the DKIM key`;
      } else {
        errorMessageText = `No DKIM TXT record found at ${recordName} yet`;
      }
    }

    const spfRecords = (await this.lookupTxt(domain.name)).filter((v) =>
      v.toLowerCase().startsWith("v=spf1"),
    );
    const spfStatus =
      spfRecords.length > 0 ? DomainStatus.SUCCESS : DomainStatus.PENDING;

    return {
      status: dkimStatus,
      dkimStatus,
      spfStatus,
      errorMessage: errorMessageText,
      checkedAt,
      dkim: { selector, recordName },
    };
  }

  private async lookupTxt(name: string) {
    try {
      const records = await this.resolveTxt(name);
      return records.map((chunks) => chunks.join(""));
    } catch {
      return [];
    }
  }

  async ensureApprovedSender(_email: string): Promise<{ created: boolean }> {
    return { created: false };
  }

  async listApprovedSenders(_domain: string): Promise<ApprovedSender[]> {
    return [];
  }

  // ---------------------------------------------------------------------------
  // Suppressions and delivery logs: tracked locally, nothing to poll.
  // ---------------------------------------------------------------------------

  async listSuppressions(_since: Date): Promise<ProviderSuppressionSummary[]> {
    return [];
  }

  async getSuppression(id: string): Promise<ProviderSuppressionDetail> {
    throw new Error(`Suppression ${id} not found (generic SMTP provider)`);
  }

  async deleteSuppression(_email: string): Promise<boolean> {
    return true;
  }

  async ensureDeliveryLogs(
    _domain: ProviderDomainRef,
  ): Promise<ProviderDeliveryLogsResult> {
    return { status: "enabled", created: [] };
  }

  async listDeliveryEvents(
    _since: Date,
    _until: Date,
  ): Promise<ProviderDeliveryEventPage> {
    return { events: [], truncated: false };
  }

  async getStatus(): Promise<ProviderStatus> {
    const errors: string[] = [];
    const smtpConfigured = Boolean(this.config.host);
    let smtpReachable: boolean | null = null;

    if (smtpConfigured && this.transport) {
      try {
        await this.transport.verify();
        smtpReachable = true;
      } catch (error) {
        smtpReachable = false;
        errors.push(`SMTP: ${this.redact(errorMessage(error))}`);
      }
    } else {
      errors.push("SMTP: SMTP_HOST is required");
    }

    return {
      provider: this.name,
      region: this.region,
      smtpHost: this.config.host ?? null,
      smtpPort: smtpConfigured ? this.config.port : null,
      smtpConfigured,
      apiConfigured: true,
      smtpReachable,
      apiReachable: null,
      errors,
      spfRecord: this.spfRecord,
      checkedAt: new Date().toISOString(),
    };
  }
}
