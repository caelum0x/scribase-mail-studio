export type EmailContent = {
  to: string | string[];
  from: string;
  subject?: string;
  templateId?: string;
  variables?: Record<string, string>;
  text?: string;
  html?: string;
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: Array<EmailAttachment>;
  headers?: Record<string, string>;
  unsubUrl?: string;
  scheduledAt?: string;
  inReplyToId?: string | null;
  /** Resend-style tags, stored on Email.tags. */
  tags?: Array<EmailTag>;
  /** Topic ID; recipients opted out of the topic are skipped. */
  topicId?: string;
};

export type EmailTag = {
  name: string;
  value: string;
};

export type EmailAttachment = {
  filename: string;
  content: string;
  /** Inline attachment Content-ID (CID). When set the MIME part is inline. */
  cid?: string;
  /** MIME content-type, e.g. "image/png". Derived from filename when absent. */
  contentType?: string;
};
