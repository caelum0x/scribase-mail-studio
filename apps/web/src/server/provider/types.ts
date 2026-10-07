/* eslint-disable no-unused-vars -- parameter names in type signatures */
import type { DomainStatus } from "@prisma/client";

/**
 * Provider abstraction for Scribase Mail.
 *
 * The rest of the app (queue, domain service, suppression service, event
 * processing) talks to this interface only. The default implementation is
 * Oracle Cloud Infrastructure (OCI) Email Delivery: SMTP for sending and the
 * OCI Email Delivery API for domains, DKIM, approved senders and suppressions.
 */

export type ProviderName = "oci";

export type SendRawEmailInput = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: {
    filename: string;
    content: string;
    /** Content-ID for inline (embedded) images. */
    cid?: string;
    /** MIME content-type, e.g. "image/png". */
    contentType?: string;
  }[];
  headers?: Record<string, string>;
  /** Full Message-ID without angle brackets, e.g. `abc@mail.example.com`. */
  messageId: string;
};

export type SendRawEmailResult = {
  /** Message-ID without angle brackets. Stored as Email.providerMessageId. */
  messageId: string;
  accepted: string[];
  rejected: string[];
  /** Raw SMTP response line from the relay, e.g. `250 2.0.0 Ok: queued`. */
  response?: string;
};

export class ProviderSendError extends Error {
  readonly retryable: boolean;
  readonly responseCode?: number;

  constructor(
    message: string,
    options: { retryable: boolean; responseCode?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "ProviderSendError";
    this.retryable = options.retryable;
    this.responseCode = options.responseCode;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export type ProviderDkimRecord = {
  dkimId?: string;
  selector?: string;
  /** Full DNS name of the CNAME, e.g. `sel._domainkey.example.com`. */
  recordName?: string;
  /** CNAME target supplied by the provider. */
  recordValue?: string;
};

export type ProviderDomainResult = {
  providerDomainId: string;
  dkim: ProviderDkimRecord;
};

export type ProviderDomainRef = {
  name: string;
  providerDomainId?: string | null;
  dkimId?: string | null;
  dkimSelector?: string | null;
};

export type ProviderDomainStatus = {
  /** Overall verification state (driven by DKIM). */
  status: DomainStatus;
  dkimStatus: DomainStatus;
  spfStatus: DomainStatus;
  errorMessage: string | null;
  checkedAt: Date;
  providerDomainId?: string;
  dkim: ProviderDkimRecord;
};

export type ProviderSuppressionReason =
  | "HARD_BOUNCE"
  | "SOFT_BOUNCE"
  | "COMPLAINT"
  | "MANUAL"
  | "UNSUBSCRIBE"
  | "UNKNOWN";

export type ProviderSuppressionSummary = {
  id: string;
  email: string;
  reason: ProviderSuppressionReason;
  createdAt: Date;
};

export type ProviderSuppressionDetail = ProviderSuppressionSummary & {
  lastSuppressedAt?: Date;
  /** Message-ID (without angle brackets) of the message that caused it. */
  messageId?: string;
  errorDetail?: string;
  errorSource?: string;
};

/** Actions recorded in the provider's per-domain delivery log. */
export type ProviderDeliveryAction =
  | "relay"
  | "bounce"
  | "complaint"
  | "open"
  | "click"
  | "unsubscribe"
  | "unknown";

/**
 * One record from the provider delivery log (OCI Email Delivery
 * "OutboundRelayed" service log). One record per recipient.
 */
export type ProviderDeliveryEvent = {
  /** Stable, unique record id (used for dedupe across polls). */
  id: string;
  action: ProviderDeliveryAction;
  timestamp: Date;
  /** Message-ID without angle brackets. */
  messageId?: string;
  recipient?: string;
  sender?: string;
  /** Email domain the record belongs to. */
  domain?: string;
  bounceType?: "hard" | "soft";
  bounceCategory?: string;
  bounceCode?: string;
  smtpStatus?: string;
  message?: string;
  /** Receiving mail server, e.g. `mx.example.com (192.0.2.1)`. */
  recipientMailServer?: string;
  processingTimeMs?: number;
  reportGeneratedTime?: Date;
};

export type ProviderDeliveryEventPage = {
  /** Records sorted by time ascending. */
  events: ProviderDeliveryEvent[];
  /** True when the page cap was hit; resume from the last event's time. */
  truncated: boolean;
};

export type ProviderDeliveryLogsResult = {
  /** enabled = logs exist; pending = domain not ready yet, retry later. */
  status: "enabled" | "pending";
  logGroupId?: string;
  /** Categories created by this call (empty when everything existed). */
  created: string[];
};

export type ApprovedSender = {
  id: string;
  email: string;
  state: string;
};

export type ProviderStatus = {
  provider: ProviderName;
  region: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpConfigured: boolean;
  apiConfigured: boolean;
  smtpReachable: boolean | null;
  apiReachable: boolean | null;
  smtpSubmitEndpoint?: string;
  errors: string[];
  spfRecord: string;
  checkedAt: string;
};

export interface EmailProvider {
  readonly name: ProviderName;
  readonly region: string;
  /** SPF value customers must publish on their sending domain. */
  readonly spfRecord: string;

  sendRawEmail(input: SendRawEmailInput): Promise<SendRawEmailResult>;

  addDomain(
    domain: string,
    options: { dkimSelector: string },
  ): Promise<ProviderDomainResult>;
  deleteDomain(domain: ProviderDomainRef): Promise<boolean>;
  getDomainStatus(domain: ProviderDomainRef): Promise<ProviderDomainStatus>;

  /** Approved senders are required by the provider for every From address. */
  ensureApprovedSender(email: string): Promise<{ created: boolean }>;
  listApprovedSenders(domain: string): Promise<ApprovedSender[]>;

  listSuppressions(since: Date): Promise<ProviderSuppressionSummary[]>;
  getSuppression(id: string): Promise<ProviderSuppressionDetail>;
  deleteSuppression(email: string): Promise<boolean>;

  /**
   * Idempotently enables the provider delivery logs for a sending domain.
   * Safe to call repeatedly; results are cached per domain.
   */
  ensureDeliveryLogs(
    domain: ProviderDomainRef,
  ): Promise<ProviderDeliveryLogsResult>;
  /** Delivery-log records (relay / bounce / complaint) in [since, until). */
  listDeliveryEvents(
    since: Date,
    until: Date,
  ): Promise<ProviderDeliveryEventPage>;

  getStatus(): Promise<ProviderStatus>;
}
