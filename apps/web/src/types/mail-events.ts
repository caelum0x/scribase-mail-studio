/**
 * Provider-neutral email event model.
 *
 * Events are produced by:
 * - the send pipeline (Send / Reject) when the SMTP relay accepts or refuses a message,
 * - the Scribase Mail tracking endpoints (Open / Click),
 * - the Email Delivery log poller (Delivery / Bounce / Complaint),
 * - the provider suppression poller (Bounce / Complaint, fallback).
 */
export interface MailMeta {
  timestamp: string;
  /** Scribase Mail email id (Email.id). Preferred lookup key. */
  emailId?: string;
  /** Message-ID assigned at send time (Email.providerMessageId). */
  messageId?: string;
  source?: string;
  destination?: string[];
  headers?: Array<{ name: string; value: string }>;
}

export interface MailBounce {
  bounceType: "Transient" | "Permanent" | "Undetermined";
  bounceSubType:
    | "General"
    | "NoEmail"
    | "Suppressed"
    | "OnAccountSuppressionList"
    | "MailboxFull"
    | "MessageTooLarge"
    | "ContentRejected"
    | "AttachmentRejected";
  bouncedRecipients: Array<{
    emailAddress: string;
    action: string;
    status: string;
    diagnosticCode?: string;
  }>;
  timestamp: string;
  feedbackId?: string;
  reportingMTA?: string;
}

export interface MailComplaint {
  complainedRecipients: Array<{
    emailAddress: string;
  }>;
  timestamp: string;
  feedbackId?: string;
  complaintFeedbackType?: string;
  userAgent?: string;
  complaintSubType?: string;
  arrivedDate?: string;
}

export interface MailDelivery {
  timestamp: string;
  processingTimeMillis: number;
  recipients: string[];
  smtpResponse: string;
  reportingMTA: string;
  remoteMtaIp?: string;
}

export interface MailSend {
  timestamp: string;
  smtpResponse?: string;
  reportingMTA?: string;
  recipients: string[];
}

export interface MailReject {
  reason: string;
  timestamp: string;
}

export interface MailOpen {
  ipAddress: string;
  timestamp: string;
  userAgent: string;
}

export interface MailClick {
  ipAddress: string;
  timestamp: string;
  userAgent: string;
  link: string;
  linkTags?: { [key: string]: string };
}

export interface MailRenderingFailure {
  errorMessage: string;
  templateName: string;
}

export interface MailDeliveryDelay {
  delayType:
    | "InternalFailure"
    | "General"
    | "MailboxFull"
    | "SpamDetected"
    | "RecipientServerError"
    | "IPFailure"
    | "TransientCommunicationFailure"
    | "BYOIPHostNameLookupUnavailable"
    | "Undetermined"
    | "SendingDeferral";
  expirationTime: string;
  delayedRecipients: string[];
  timestamp: string;
}

export type MailEventType =
  | "Bounce"
  | "Complaint"
  | "Delivery"
  | "Send"
  | "Reject"
  | "Open"
  | "Click"
  | "Rendering Failure"
  | "DeliveryDelay";

export type MailEventDataKey =
  | "bounce"
  | "complaint"
  | "delivery"
  | "send"
  | "reject"
  | "open"
  | "click"
  | "renderingFailure"
  | "deliveryDelay";

export interface MailEvent {
  eventType: MailEventType;
  mail: MailMeta;
  bounce?: MailBounce;
  complaint?: MailComplaint;
  delivery?: MailDelivery;
  send?: MailSend;
  reject?: MailReject;
  open?: MailOpen;
  click?: MailClick;
  renderingFailure?: MailRenderingFailure;
  deliveryDelay?: MailDeliveryDelay;
  // Additional fields for other event types can be added here
}
