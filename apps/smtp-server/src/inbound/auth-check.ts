/**
 * SPF / DKIM / DMARC / ARC authentication checks using the `mailauth` package
 * (MIT-licensed). Called once per inbound message before storage.
 */

import { authenticate } from "mailauth";

export type AuthResults = {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  /** True when DMARC policy is `reject` and this message fails the check. */
  dmarcReject: boolean;
};

/**
 * Run email authentication checks on the raw message bytes.
 *
 * @param rawMessage - The complete RFC 5322 message as a Buffer.
 * @param clientIp   - The IP address of the sending SMTP client.
 * @param mailFrom   - The MAIL FROM address (envelope sender).
 * @param ehloName   - The EHLO / HELO hostname provided by the client.
 */
export async function checkAuth(
  rawMessage: Buffer,
  clientIp: string,
  mailFrom: string,
  ehloName: string,
): Promise<AuthResults> {
  const result = await authenticate(rawMessage, {
    ip: clientIp,
    helo: ehloName,
    sender: mailFrom,
    // Disable ARC sealing (we are not an intermediate hop; we are the final MX).
    seal: undefined,
  });

  // mailauth returns `false` for checks it could not run.
  const spf = result.spf ? (result.spf.status?.result ?? null) : null;
  const dkim =
    result.dkim?.results?.[0]?.status?.result ??
    (result.dkim?.results?.length ? "none" : null);
  const dmarc = result.dmarc || null;
  const dmarcResult = dmarc?.status?.result ?? null;
  const dmarcPolicy = dmarc?.policy ?? null;
  const dmarcReject =
    dmarcPolicy === "reject" &&
    (dmarcResult === "fail" || dmarcResult === "permerror");

  return {
    spf,
    dkim,
    dmarc: dmarcResult,
    dmarcReject,
  };
}
