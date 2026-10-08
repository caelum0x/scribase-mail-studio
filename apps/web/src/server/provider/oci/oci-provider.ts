import type { requests, responses, models } from "oci-email";
import type { SendMailOptions, SentMessageInfo } from "nodemailer";
import { DomainStatus } from "@prisma/client";
import { logger } from "~/server/logger/log";
import {
  ProviderSendError,
  type ApprovedSender,
  type EmailProvider,
  type ProviderDeliveryEventPage,
  type ProviderDeliveryLogsResult,
  type ProviderDkimRecord,
  type ProviderDomainRef,
  type ProviderDomainResult,
  type ProviderDomainStatus,
  type ProviderStatus,
  type ProviderSuppressionDetail,
  type ProviderSuppressionSummary,
  type SendRawEmailInput,
  type SendRawEmailResult,
} from "../types";
import { isOciApiConfigured, isSmtpConfigured, type OciConfig } from "./config";
import {
  OCI_SPF_RECORD,
  buildDkimSelector,
  dkimRecordName,
  extractEmailAddress,
  mapDkimLifecycleState,
  mapSuppressionReason,
  stripAngleBrackets,
} from "./mappers";
import {
  OciDeliveryLogs,
  type OciLogSearchApi,
  type OciLoggingApi,
} from "./delivery-logs";

/* eslint-disable no-unused-vars -- parameter names in type signatures */
/** Subset of the OCI EmailClient used by Scribase Mail (eases mocking). */
export type OciEmailApi = {
  createEmailDomain(
    req: requests.CreateEmailDomainRequest,
  ): Promise<Pick<responses.CreateEmailDomainResponse, "emailDomain">>;
  getEmailDomain(
    req: requests.GetEmailDomainRequest,
  ): Promise<Pick<responses.GetEmailDomainResponse, "emailDomain">>;
  listEmailDomains(
    req: requests.ListEmailDomainsRequest,
  ): Promise<Pick<responses.ListEmailDomainsResponse, "emailDomainCollection">>;
  deleteEmailDomain(req: requests.DeleteEmailDomainRequest): Promise<unknown>;
  createDkim(
    req: requests.CreateDkimRequest,
  ): Promise<Pick<responses.CreateDkimResponse, "dkim">>;
  getDkim(
    req: requests.GetDkimRequest,
  ): Promise<Pick<responses.GetDkimResponse, "dkim">>;
  listDkims(
    req: requests.ListDkimsRequest,
  ): Promise<Pick<responses.ListDkimsResponse, "dkimCollection">>;
  createSender(
    req: requests.CreateSenderRequest,
  ): Promise<Pick<responses.CreateSenderResponse, "sender">>;
  listSenders(
    req: requests.ListSendersRequest,
  ): Promise<
    Pick<responses.ListSendersResponse, "items"> & { opcNextPage?: string }
  >;
  listSuppressions(req: requests.ListSuppressionsRequest): Promise<
    Pick<responses.ListSuppressionsResponse, "items"> & {
      opcNextPage?: string;
    }
  >;
  getSuppression(
    req: requests.GetSuppressionRequest,
  ): Promise<Pick<responses.GetSuppressionResponse, "suppression">>;
  deleteSuppression(req: requests.DeleteSuppressionRequest): Promise<unknown>;
  getEmailConfiguration(
    req: requests.GetEmailConfigurationRequest,
  ): Promise<Pick<responses.GetEmailConfigurationResponse, "configuration">>;
};

export type SmtpTransport = {
  sendMail(mail: SendMailOptions): Promise<SentMessageInfo>;
  verify(): Promise<unknown>;
};

/* eslint-enable no-unused-vars */

export type OciEmailProviderDeps = {
  config: OciConfig;
  api: OciEmailApi | null;
  transport: SmtpTransport | null;
  logging?: OciLoggingApi | null;
  logSearch?: OciLogSearchApi | null;
  // eslint-disable-next-line no-unused-vars -- parameter name in type signature
  sleep?: (durationMs: number) => Promise<void>;
  senderCacheTtlMs?: number;
  domainActivePollAttempts?: number;
  domainActivePollIntervalMs?: number;
};

const DKIM_SELECTOR_PREFIX = "scribase";
const RETRYABLE_SOCKET_CODES = new Set([
  "ECONNECTION",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "EPROTOCOL",
]);
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

function getStatusCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** RFC 3339 UTC timestamp without milliseconds, e.g. 2026-10-07T09:00:00Z. */
export function toRfc3339Utc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class ProviderNotConfiguredError extends Error {
  constructor(what: string) {
    super(`Oracle Cloud Email Delivery ${what} is not configured`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class OciEmailProvider implements EmailProvider {
  readonly name = "oci" as const;
  readonly spfRecord = OCI_SPF_RECORD;
  readonly dkimRecordType = "CNAME" as const;
  readonly region: string;

  private readonly config: OciConfig;
  private readonly apiClient: OciEmailApi | null;
  private readonly transport: SmtpTransport | null;
  // eslint-disable-next-line no-unused-vars -- parameter name in type signature
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly senderCacheTtlMs: number;
  private readonly domainActivePollAttempts: number;
  private readonly domainActivePollIntervalMs: number;
  private readonly approvedSenderCache = new Map<string, number>();
  private readonly deliveryLogs: OciDeliveryLogs;

  constructor(deps: OciEmailProviderDeps) {
    this.config = deps.config;
    this.region = deps.config.region;
    this.apiClient = deps.api;
    this.transport = deps.transport;
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.senderCacheTtlMs = deps.senderCacheTtlMs ?? 60 * 60 * 1000;
    this.domainActivePollAttempts = deps.domainActivePollAttempts ?? 10;
    this.domainActivePollIntervalMs = deps.domainActivePollIntervalMs ?? 2000;
    this.deliveryLogs = new OciDeliveryLogs({
      compartmentId: deps.config.compartmentId,
      logGroupName: deps.config.logGroupName,
      logging: deps.logging ?? null,
      logSearch: deps.logSearch ?? null,
      sleep: this.sleep,
    });
  }

  // ---------------------------------------------------------------------------
  // Sending (SMTP)
  // ---------------------------------------------------------------------------

  async sendRawEmail(input: SendRawEmailInput): Promise<SendRawEmailResult> {
    if (!this.transport) {
      throw new ProviderSendError("SMTP relay is not configured", {
        retryable: false,
      });
    }

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
    for (const secret of [this.config.smtp.pass, this.config.smtp.user]) {
      if (secret && secret.length >= 4) {
        result = result.split(secret).join("***");
      }
    }
    return result;
  }

  private toSendError(error: unknown) {
    const err = (error ?? {}) as {
      responseCode?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const responseCode =
      typeof err.responseCode === "number" ? err.responseCode : undefined;
    const code = typeof err.code === "string" ? err.code : undefined;
    const rawMessage = this.redact(errorMessage(error));

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
        : `SMTP send failed${responseCode ? ` (${responseCode})` : ""}: ${rawMessage}`;

    return new ProviderSendError(message, {
      retryable,
      responseCode,
      cause: error,
    });
  }

  // ---------------------------------------------------------------------------
  // Domains + DKIM
  // ---------------------------------------------------------------------------

  private get api(): OciEmailApi {
    if (!this.apiClient) {
      throw new ProviderNotConfiguredError("API");
    }
    return this.apiClient;
  }

  private get compartmentId(): string {
    if (!this.config.compartmentId) {
      throw new ProviderNotConfiguredError("compartment");
    }
    return this.config.compartmentId;
  }

  async addDomain(
    domain: string,
    options: { dkimSelector: string },
  ): Promise<ProviderDomainResult> {
    const emailDomain = await this.findOrCreateEmailDomain(domain);
    const isActive = await this.waitForEmailDomainActive(emailDomain.id);

    if (!isActive) {
      logger.warn(
        { domain, emailDomainId: emailDomain.id },
        "[OciEmailProvider]: Email domain not active yet; DKIM will be created on next verification",
      );
      return {
        providerDomainId: emailDomain.id,
        dkim: {
          selector: options.dkimSelector,
          recordName: dkimRecordName(options.dkimSelector, domain),
        },
      };
    }

    const { record } = await this.findOrCreateDkim(
      emailDomain.id,
      domain,
      options.dkimSelector,
    );

    return { providerDomainId: emailDomain.id, dkim: record };
  }

  async deleteDomain(domain: ProviderDomainRef): Promise<boolean> {
    let emailDomainId = domain.providerDomainId ?? undefined;
    if (!emailDomainId) {
      emailDomainId = (await this.findEmailDomainByName(domain.name))?.id;
    }

    if (!emailDomainId) {
      // Nothing to delete at the provider.
      return true;
    }

    try {
      await this.api.deleteEmailDomain({ emailDomainId });
      return true;
    } catch (error) {
      if (getStatusCode(error) === 404) {
        return true;
      }
      logger.error(
        { err: error, domain: domain.name },
        "[OciEmailProvider]: Failed to delete email domain",
      );
      return false;
    }
  }

  async getDomainStatus(
    domain: ProviderDomainRef,
  ): Promise<ProviderDomainStatus> {
    const checkedAt = new Date();
    const emailDomain = await this.loadEmailDomain(domain);

    if (!emailDomain) {
      return {
        status: DomainStatus.FAILED,
        dkimStatus: DomainStatus.FAILED,
        spfStatus: DomainStatus.NOT_STARTED,
        errorMessage: `Email domain ${domain.name} was not found in Oracle Cloud Email Delivery`,
        checkedAt,
        dkim: {},
      };
    }

    if (emailDomain.lifecycleState === "FAILED") {
      return {
        status: DomainStatus.FAILED,
        dkimStatus: DomainStatus.FAILED,
        spfStatus: DomainStatus.NOT_STARTED,
        errorMessage: "Email domain provisioning failed",
        checkedAt,
        providerDomainId: emailDomain.id,
        dkim: {},
      };
    }

    const dkimId = domain.dkimId ?? emailDomain.activeDkimId ?? undefined;
    let dkim: models.Dkim | undefined;
    let record: ProviderDkimRecord = {};

    if (dkimId) {
      try {
        dkim = (await this.api.getDkim({ dkimId })).dkim;
        record = this.mapDkimRecord(dkim, domain.name);
      } catch (error) {
        if (getStatusCode(error) !== 404) {
          throw error;
        }
      }
    }

    if (!dkim && emailDomain.lifecycleState === "ACTIVE") {
      const created = await this.findOrCreateDkim(
        emailDomain.id,
        domain.name,
        domain.dkimSelector ??
          buildDkimSelector(DKIM_SELECTOR_PREFIX, this.region),
      );
      dkim = created.dkim;
      record = created.record;
    }

    const dkimStatus = dkim
      ? mapDkimLifecycleState(dkim.lifecycleState)
      : DomainStatus.PENDING;
    const spfStatus = emailDomain.isSpf
      ? DomainStatus.SUCCESS
      : DomainStatus.PENDING;

    return {
      status: dkimStatus,
      dkimStatus,
      spfStatus,
      errorMessage:
        dkimStatus === DomainStatus.SUCCESS
          ? null
          : (dkim?.lifecycleDetails ?? null),
      checkedAt,
      providerDomainId: emailDomain.id,
      dkim: record,
    };
  }

  private async loadEmailDomain(
    domain: ProviderDomainRef,
  ): Promise<models.EmailDomain | undefined> {
    if (domain.providerDomainId) {
      try {
        const res = await this.api.getEmailDomain({
          emailDomainId: domain.providerDomainId,
        });
        return res.emailDomain;
      } catch (error) {
        if (getStatusCode(error) !== 404) {
          throw error;
        }
      }
    }

    const summary = await this.findEmailDomainByName(domain.name);
    if (!summary) {
      return undefined;
    }
    const res = await this.api.getEmailDomain({ emailDomainId: summary.id });
    return res.emailDomain;
  }

  private async findEmailDomainByName(name: string) {
    const res = await this.api.listEmailDomains({
      compartmentId: this.compartmentId,
      name,
    });
    return res.emailDomainCollection?.items?.find(
      (item) => !item.name || item.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private async findOrCreateEmailDomain(name: string) {
    try {
      const res = await this.api.createEmailDomain({
        createEmailDomainDetails: {
          name,
          compartmentId: this.compartmentId,
          description: "Managed by Scribase Mail",
        },
      });
      return res.emailDomain;
    } catch (error) {
      if (getStatusCode(error) !== 409) {
        throw error;
      }
      const existing = await this.findEmailDomainByName(name);
      if (!existing) {
        throw error;
      }
      logger.info(
        { domain: name, emailDomainId: existing.id },
        "[OciEmailProvider]: Reusing existing email domain",
      );
      return existing;
    }
  }

  private async waitForEmailDomainActive(emailDomainId: string) {
    for (let attempt = 0; attempt < this.domainActivePollAttempts; attempt++) {
      const res = await this.api.getEmailDomain({ emailDomainId });
      const state = res.emailDomain?.lifecycleState;
      if (state === "ACTIVE") {
        return true;
      }
      if (state === "FAILED" || state === "DELETED" || state === "DELETING") {
        throw new Error(`Email domain is in state ${state}`);
      }
      await this.sleep(this.domainActivePollIntervalMs);
    }
    return false;
  }

  private mapDkimRecord(
    dkim: Pick<
      models.Dkim,
      "id" | "name" | "dnsSubdomainName" | "cnameRecordValue"
    >,
    domain: string,
  ): ProviderDkimRecord {
    return {
      dkimId: dkim.id,
      selector: dkim.name,
      recordName: dkim.dnsSubdomainName ?? dkimRecordName(dkim.name, domain),
      recordValue: dkim.cnameRecordValue,
    };
  }

  private async findOrCreateDkim(
    emailDomainId: string,
    domain: string,
    selector: string,
  ): Promise<{ dkim: models.Dkim; record: ProviderDkimRecord }> {
    const existing = await this.api.listDkims({ emailDomainId });
    const items = existing.dkimCollection?.items ?? [];
    const usable =
      items.find((item) => item.lifecycleState === "ACTIVE") ??
      items.find((item) =>
        ["CREATING", "UPDATING", "NEEDS_ATTENTION"].includes(
          String(item.lifecycleState),
        ),
      );

    if (usable) {
      const res = await this.api.getDkim({ dkimId: usable.id });
      return { dkim: res.dkim, record: this.mapDkimRecord(res.dkim, domain) };
    }

    const res = await this.api.createDkim({
      createDkimDetails: {
        name: selector,
        emailDomainId,
        description: "Managed by Scribase Mail",
      },
    });

    return { dkim: res.dkim, record: this.mapDkimRecord(res.dkim, domain) };
  }

  // ---------------------------------------------------------------------------
  // Approved senders
  // ---------------------------------------------------------------------------

  async ensureApprovedSender(rawEmail: string): Promise<{ created: boolean }> {
    const emailAddress = extractEmailAddress(rawEmail);
    const cachedUntil = this.approvedSenderCache.get(emailAddress);
    if (cachedUntil && cachedUntil > Date.now()) {
      return { created: false };
    }

    const existing = await this.api.listSenders({
      compartmentId: this.compartmentId,
      emailAddress,
    });
    const match = (existing.items ?? []).find(
      (item) =>
        item.emailAddress?.toLowerCase() === emailAddress &&
        !["DELETING", "DELETED", "FAILED"].includes(
          String(item.lifecycleState ?? ""),
        ),
    );

    if (match) {
      this.cacheSender(emailAddress);
      return { created: false };
    }

    try {
      await this.api.createSender({
        createSenderDetails: {
          compartmentId: this.compartmentId,
          emailAddress,
        },
      });
      logger.info(
        { emailAddress },
        "[OciEmailProvider]: Created approved sender",
      );
      this.cacheSender(emailAddress);
      return { created: true };
    } catch (error) {
      if (getStatusCode(error) === 409) {
        this.cacheSender(emailAddress);
        return { created: false };
      }
      throw error;
    }
  }

  private cacheSender(emailAddress: string) {
    this.approvedSenderCache.set(
      emailAddress,
      Date.now() + this.senderCacheTtlMs,
    );
  }

  async listApprovedSenders(domain: string): Promise<ApprovedSender[]> {
    const senders: ApprovedSender[] = [];
    let page: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await this.api.listSenders({
        compartmentId: this.compartmentId,
        domain,
        page,
        limit: PAGE_LIMIT,
      });
      for (const item of res.items ?? []) {
        senders.push({
          id: item.id,
          email: item.emailAddress,
          state: String(item.lifecycleState ?? "UNKNOWN"),
        });
      }
      page = res.opcNextPage;
      if (!page) break;
    }
    return senders;
  }

  // ---------------------------------------------------------------------------
  // Suppressions
  // ---------------------------------------------------------------------------

  async listSuppressions(since: Date): Promise<ProviderSuppressionSummary[]> {
    const result: ProviderSuppressionSummary[] = [];
    let page: string | undefined;

    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await this.api.listSuppressions({
        compartmentId: this.compartmentId,
        // The OCI SDK formats Date query params in local time with an
        // unpadded hour, which the API rejects; pass RFC 3339 UTC instead.
        timeCreatedGreaterThanOrEqualTo: toRfc3339Utc(since) as unknown as Date,
        sortBy: "timeCreated" as requests.ListSuppressionsRequest.SortBy,
        sortOrder: "ASC" as models.SortOrder,
        limit: PAGE_LIMIT,
        page,
      });

      for (const item of res.items ?? []) {
        result.push({
          id: item.id,
          email: item.emailAddress.toLowerCase(),
          reason: mapSuppressionReason(item.reason),
          createdAt: item.timeCreated ? new Date(item.timeCreated) : new Date(),
        });
      }

      page = res.opcNextPage;
      if (!page) break;
    }

    return result;
  }

  async getSuppression(id: string): Promise<ProviderSuppressionDetail> {
    const { suppression } = await this.api.getSuppression({
      suppressionId: id,
    });

    return {
      id: suppression.id,
      email: suppression.emailAddress.toLowerCase(),
      reason: mapSuppressionReason(suppression.reason),
      createdAt: suppression.timeCreated
        ? new Date(suppression.timeCreated)
        : new Date(),
      lastSuppressedAt: suppression.timeLastSuppressed
        ? new Date(suppression.timeLastSuppressed)
        : undefined,
      messageId: suppression.messageId
        ? stripAngleBrackets(suppression.messageId)
        : undefined,
      errorDetail: suppression.errorDetail,
      errorSource: suppression.errorSource,
    };
  }

  async deleteSuppression(email: string): Promise<boolean> {
    const emailAddress = email.toLowerCase().trim();
    try {
      const res = await this.api.listSuppressions({
        compartmentId: this.compartmentId,
        emailAddress,
        limit: PAGE_LIMIT,
      });

      for (const item of res.items ?? []) {
        await this.api.deleteSuppression({ suppressionId: item.id });
      }

      return true;
    } catch (error) {
      if (getStatusCode(error) === 404) {
        return true;
      }
      logger.error(
        { err: error, email: emailAddress },
        "[OciEmailProvider]: Failed to remove provider suppression",
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Delivery logs (delivered / bounced / complained events)
  // ---------------------------------------------------------------------------

  async ensureDeliveryLogs(
    domain: ProviderDomainRef,
  ): Promise<ProviderDeliveryLogsResult> {
    if (
      domain.providerDomainId &&
      this.deliveryLogs.isEnsured(domain.providerDomainId)
    ) {
      return this.deliveryLogs.ensureForEmailDomain(
        domain.providerDomainId,
        domain.name,
      );
    }

    const emailDomain = await this.loadEmailDomain(domain);
    // Service logs can only be attached to an ACTIVE email domain.
    if (!emailDomain || emailDomain.lifecycleState !== "ACTIVE") {
      return { status: "pending", created: [] };
    }
    return this.deliveryLogs.ensureForEmailDomain(emailDomain.id, domain.name);
  }

  async listDeliveryEvents(
    since: Date,
    until: Date,
  ): Promise<ProviderDeliveryEventPage> {
    return this.deliveryLogs.listEvents(since, until);
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<ProviderStatus> {
    const errors: string[] = [];
    const smtpConfigured = isSmtpConfigured(this.config);
    const apiConfigured = isOciApiConfigured(this.config);
    let smtpReachable: boolean | null = null;
    let apiReachable: boolean | null = null;
    let smtpSubmitEndpoint: string | undefined;

    if (smtpConfigured && this.transport) {
      try {
        await this.transport.verify();
        smtpReachable = true;
      } catch (error) {
        smtpReachable = false;
        errors.push(`SMTP: ${this.redact(errorMessage(error))}`);
      }
    } else {
      errors.push("SMTP: SMTP_HOST, SMTP_USER and SMTP_PASS are required");
    }

    if (apiConfigured && this.apiClient) {
      try {
        const res = await this.apiClient.getEmailConfiguration({
          compartmentId: this.compartmentId,
        });
        apiReachable = true;
        smtpSubmitEndpoint = res.configuration?.smtpSubmitEndpoint;
      } catch (error) {
        apiReachable = false;
        errors.push(`API: ${errorMessage(error)}`);
      }
    } else {
      errors.push(
        "API: OCI_TENANCY, OCI_USER, OCI_FINGERPRINT and OCI_PRIVATE_KEY are required",
      );
    }

    return {
      provider: this.name,
      region: this.region,
      smtpHost: this.config.smtp.host ?? null,
      smtpPort: smtpConfigured ? this.config.smtp.port : null,
      smtpConfigured,
      apiConfigured,
      smtpReachable,
      apiReachable,
      smtpSubmitEndpoint,
      errors,
      spfRecord: this.spfRecord,
      checkedAt: new Date().toISOString(),
    };
  }
}
