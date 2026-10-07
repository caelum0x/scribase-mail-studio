/**
 * Inbound MX server — accepts mail on port 25 for domains that have
 * `receivingEnabled = true` in Scribase Mail.
 *
 * Pipeline per message:
 *  1. Collect raw bytes from DATA stream.
 *  2. Check recipient domain against the allowlist fetched from the web app.
 *  3. Verify SPF / DKIM / DMARC with `mailauth`.
 *  4. Drop messages where DMARC policy is `reject` and authentication fails.
 *  5. Run optional ClamAV scan when CLAMD_HOST is set.
 *  6. Store raw .eml in OCI Object Storage (or local disk for dev).
 *  7. Parse MIME with `mailparser`; store each attachment separately.
 *  8. POST parsed data to the web app's internal inbound route.
 */

import { SMTPServer, SMTPServerSession } from "smtp-server";
import { Readable } from "stream";
import { readFileSync } from "fs";
import { simpleParser } from "mailparser";
import { checkAuth } from "./auth-check";
import { storeObject } from "./storage";
import { postInboundMail } from "./api-client";

// ─── Configuration ────────────────────────────────────────────────────────────

const INBOUND_PORT = parseInt(process.env.INBOUND_PORT ?? "25", 10);
const MAX_MESSAGE_BYTES = parseInt(
  process.env.INBOUND_MAX_SIZE_BYTES ?? String(25 * 1024 * 1024),
  10,
);
const MAX_CONNECTIONS_PER_IP = parseInt(
  process.env.INBOUND_MAX_CONNECTIONS_PER_IP ?? "5",
  10,
);
const CLAMD_HOST = process.env.CLAMD_HOST ?? "";
const CLAMD_PORT = parseInt(process.env.CLAMD_PORT ?? "3310", 10);
const SSL_KEY_PATH = process.env.INBOUND_SSL_KEY_PATH ?? process.env.USESEND_API_KEY_PATH ?? "";
const SSL_CERT_PATH = process.env.INBOUND_SSL_CERT_PATH ?? process.env.USESEND_API_CERT_PATH ?? "";

/** Resolvable receiving domains, refreshed every 5 minutes from the web app. */
const BASE_URL =
  process.env.SCRIBASE_MAIL_BASE_URL ??
  process.env.USESEND_BASE_URL ??
  process.env.UNSEND_BASE_URL ??
  "https://mail.scribase.com";

const INTERNAL_SECRET = process.env.INBOUND_INTERNAL_SECRET ?? "";

let receivingDomains = new Set<string>();

async function refreshReceivingDomains(): Promise<void> {
  try {
    const url = `${BASE_URL.replace(/\/+$/, "")}/api/internal/inbound/domains`;
    const res = await fetch(url, {
      headers: { "X-Internal-Secret": INTERNAL_SECRET },
    });
    if (!res.ok) return;
    const { domains } = (await res.json()) as { domains: string[] };
    receivingDomains = new Set(domains);
    console.log(`[inbound] Receiving domains refreshed (${receivingDomains.size} active)`);
  } catch (err) {
    console.error("[inbound] Failed to refresh receiving domains:", err);
  }
}

// Initial load + periodic refresh every 5 minutes.
void refreshReceivingDomains();
setInterval(() => void refreshReceivingDomains(), 5 * 60 * 1000);

// ─── Optional ClamAV scan ─────────────────────────────────────────────────────

async function scanForVirus(data: Buffer): Promise<boolean> {
  if (!CLAMD_HOST) return false; // scanning disabled
  try {
    const net = await import("net");
    return new Promise<boolean>((resolve) => {
      const client = new net.Socket();
      client.connect(CLAMD_PORT, CLAMD_HOST, () => {
        const sizeBuffer = Buffer.alloc(4);
        sizeBuffer.writeUInt32BE(data.length, 0);
        client.write("zINSTREAM\0");
        client.write(sizeBuffer);
        client.write(data);
        const zeroChunk = Buffer.alloc(4);
        client.write(zeroChunk);
      });
      let response = "";
      client.on("data", (chunk: Buffer) => {
        response += chunk.toString();
      });
      client.on("end", () => {
        // ClamAV returns "stream: OK\0" for clean, "stream: <Virus> FOUND\0" for infected
        resolve(response.includes("FOUND"));
        client.destroy();
      });
      client.on("error", () => {
        console.error("[inbound] ClamAV scan error; skipping scan");
        resolve(false);
        client.destroy();
      });
      // Timeout after 30 s
      client.setTimeout(30_000, () => {
        console.error("[inbound] ClamAV scan timed out; skipping");
        resolve(false);
        client.destroy();
      });
    });
  } catch (err) {
    console.error("[inbound] ClamAV scan failed:", err);
    return false;
  }
}

// ─── Connections-per-IP tracker ───────────────────────────────────────────────

const connsByIp = new Map<string, number>();

function incrementConn(ip: string): void {
  connsByIp.set(ip, (connsByIp.get(ip) ?? 0) + 1);
}

function decrementConn(ip: string): void {
  const n = connsByIp.get(ip) ?? 1;
  if (n <= 1) {
    connsByIp.delete(ip);
  } else {
    connsByIp.set(ip, n - 1);
  }
}

// ─── SMTP server ─────────────────────────────────────────────────────────────

const tlsOptions =
  SSL_KEY_PATH && SSL_CERT_PATH
    ? { key: readFileSync(SSL_KEY_PATH), cert: readFileSync(SSL_CERT_PATH) }
    : {};

export function createInboundServer(): SMTPServer {
  return new SMTPServer({
    secure: false,
    ...tlsOptions,
    name: "inbound.scribase.com",
    banner: "Scribase Mail inbound MX",
    size: MAX_MESSAGE_BYTES,
    disabledCommands: ["AUTH"],
    authOptional: true,

    onConnect(session: SMTPServerSession, callback: (err?: Error) => void) {
      const ip = session.remoteAddress;
      const current = connsByIp.get(ip) ?? 0;
      if (current >= MAX_CONNECTIONS_PER_IP) {
        return callback(new Error("Too many connections from this IP"));
      }
      incrementConn(ip);
      callback();
    },

    onClose(session: SMTPServerSession) {
      decrementConn(session.remoteAddress);
    },

    onRcptTo(
      address: { address: string },
      session: SMTPServerSession,
      callback: (err?: Error) => void,
    ) {
      const domain = address.address.split("@").pop()?.toLowerCase() ?? "";
      if (!receivingDomains.has(domain)) {
        const err = Object.assign(
          new Error(`Recipient domain ${domain} does not accept mail here`),
          { responseCode: 550 },
        );
        return callback(err);
      }
      callback();
    },

    async onData(
      stream: Readable,
      session: SMTPServerSession,
      callback: (err?: Error) => void,
    ) {
      // 1. Collect raw bytes
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        totalBytes += chunk.length;
      });

      stream.on("end", async () => {
        const rawBuffer = Buffer.concat(chunks);

        try {
          const clientIp = session.remoteAddress;
          const mailFrom = session.envelope.mailFrom
            ? (session.envelope.mailFrom as unknown as { address: string }).address
            : "";
          const rcptDomains = [
            ...new Set(
              session.envelope.rcptTo.map(
                (r) => (r as unknown as { address: string }).address.split("@").pop()?.toLowerCase() ?? "",
              ),
            ),
          ];

          // 2. Reject unknown recipient domains (belt-and-suspenders)
          for (const domain of rcptDomains) {
            if (!receivingDomains.has(domain)) {
              return callback(
                Object.assign(new Error(`550 No such domain: ${domain}`), {
                  responseCode: 550,
                }),
              );
            }
          }

          // 3. SPF / DKIM / DMARC
          const authResults = await checkAuth(
            rawBuffer,
            clientIp,
            mailFrom,
            session.hostNameAppearsAs ?? "unknown",
          );

          // 4. Drop if DMARC reject policy and authentication failed
          if (authResults.dmarcReject) {
            console.warn(
              `[inbound] DMARC reject for ${mailFrom} from ${clientIp}; dropping`,
            );
            return callback(
              Object.assign(
                new Error("550 Message rejected per DMARC policy"),
                { responseCode: 550 },
              ),
            );
          }

          // 5. Optional virus scan
          const infected = await scanForVirus(rawBuffer);
          if (infected) {
            console.warn(`[inbound] Virus detected from ${clientIp}; rejecting`);
            return callback(
              Object.assign(new Error("550 Virus detected"), { responseCode: 550 }),
            );
          }

          // 6. Store raw .eml
          const emlKey = `inbound/raw/${Date.now()}-${Math.random().toString(36).slice(2)}.eml`;
          let rawStorageKey: string | null = null;
          try {
            rawStorageKey = await storeObject(emlKey, rawBuffer, "message/rfc822");
          } catch (storageErr) {
            console.error("[inbound] Raw EML storage failed:", storageErr);
            // Continue: we can still store the parsed content
          }

          // 7. Parse MIME
          const parsed = await simpleParser(rawBuffer);

          // Store each attachment and collect metadata
          const attachments = await Promise.all(
            (parsed.attachments ?? []).map(async (att, i) => {
              const attKey = `inbound/attachments/${Date.now()}-${i}-${
                att.filename ?? "attachment"
              }`;
              let storedKey = attKey;
              try {
                storedKey = await storeObject(
                  attKey,
                  att.content,
                  att.contentType ?? "application/octet-stream",
                );
              } catch (attErr) {
                console.error("[inbound] Attachment storage failed:", attErr);
              }
              return {
                filename: att.filename ?? `attachment-${i + 1}`,
                contentType: att.contentType ?? null,
                contentId: att.contentId ?? null,
                contentDisposition: att.contentDisposition ?? null,
                sizeBytes: att.content.length,
                storageKey: storedKey,
              };
            }),
          );

          // 8. POST to web app
          const toAddresses: string[] = parsed.to
            ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap(
                (addr) => (addr.value ?? []).map((v) => v.address ?? ""),
              )
            : session.envelope.rcptTo.map(
                (r) => (r as unknown as { address: string }).address,
              );

          const ccAddresses: string[] = parsed.cc
            ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).flatMap(
                (addr) => (addr.value ?? []).map((v) => v.address ?? ""),
              )
            : [];

          const fromAddress =
            (Array.isArray(parsed.from)
              ? parsed.from[0]
              : parsed.from)?.text ?? mailFrom;

          await postInboundMail({
            recipientDomain: rcptDomains[0] ?? "",
            messageId: parsed.messageId ?? null,
            from: fromAddress,
            to: toAddresses.filter(Boolean),
            cc: ccAddresses.filter(Boolean),
            subject: parsed.subject ?? "(no subject)",
            text: parsed.text ?? null,
            html: (typeof parsed.html === "string" ? parsed.html : null),
            rawStorageKey,
            sizeBytes: totalBytes,
            spfResult: authResults.spf,
            dkimResult: authResults.dkim,
            dmarcResult: authResults.dmarc,
            attachments,
          });

          callback();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[inbound] Processing error:", message);
          // Temporary failure so the sender retries
          callback(
            Object.assign(new Error(`451 Temporary processing error`), {
              responseCode: 451,
            }),
          );
        }
      });

      stream.on("error", (err: Error) => {
        console.error("[inbound] Stream error:", err.message);
        callback(err);
      });
    },
  });
}

/**
 * Start the inbound MX server and return it.
 * Called from the main `server.ts` entry point.
 */
export function startInboundServer(): SMTPServer {
  const server = createInboundServer();
  server.listen(INBOUND_PORT, () => {
    console.log(`[inbound] MX server listening on port ${INBOUND_PORT} (STARTTLS)`);
  });
  server.on("error", (err: Error) => {
    console.error("[inbound] SMTP server error:", err.message);
  });
  return server;
}
