/**
 * HTTP client used by the inbound MX process to push parsed mail data into
 * the web app for database persistence and webhook dispatch.
 *
 * The web app exposes an internal POST endpoint at:
 *   POST /api/internal/inbound
 * protected by a shared secret (`INBOUND_INTERNAL_SECRET`).
 */

export type AttachmentPayload = {
  filename: string;
  contentType?: string | null;
  contentId?: string | null;
  contentDisposition?: string | null;
  sizeBytes: number;
  storageKey: string;
};

export type InboundMailPayload = {
  /** Recipient domain (e.g. "acme.example.com"). Used to resolve the team. */
  recipientDomain: string;
  messageId?: string | null;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string>;
  rawStorageKey?: string | null;
  sizeBytes: number;
  spfResult?: string | null;
  dkimResult?: string | null;
  dmarcResult?: string | null;
  spamScore?: number | null;
  attachments?: AttachmentPayload[];
};

const BASE_URL =
  process.env.SCRIBASE_MAIL_BASE_URL ??
  process.env.USESEND_BASE_URL ??
  process.env.UNSEND_BASE_URL ??
  "https://mail.scribase.com";

const INTERNAL_SECRET = process.env.INBOUND_INTERNAL_SECRET ?? "";

/**
 * POST the parsed inbound email to the web app for persistence.
 * Throws on HTTP error so the caller can issue a temporary failure (SMTP 4xx).
 */
export async function postInboundMail(payload: InboundMailPayload): Promise<void> {
  const url = `${BASE_URL.replace(/\/+$/, "")}/api/internal/inbound`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_SECRET,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(
      `Inbound relay failed ${response.status}: ${text}`,
    );
  }
}
