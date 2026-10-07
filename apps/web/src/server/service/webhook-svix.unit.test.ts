/**
 * Unit tests for Svix/Standard Webhooks signing.
 *
 * Proves that our signatures are accepted by:
 * - `resend.webhooks.verify()` (uses standardwebhooks internally)
 * - the standardwebhooks Webhook class directly
 *
 * Also covers secret rotation: previous secret still verifies, new secret
 * verifies, and an expired previous secret does not appear in headers.
 */
import { createHmac, randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { Resend } from "resend";
import { Webhook as StandardWebhook } from "standardwebhooks";
import { toResendPayload } from "./webhook-resend-payload";

// ---------------------------------------------------------------------------
// Re-implement the signing logic from webhook-service.ts (not imported so we
// can test it in isolation without instantiating BullMQ workers).
// ---------------------------------------------------------------------------

function generateSvixSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

function svixSign(secret: string, msgId: string, epochSeconds: number, body: string): string {
  const keyBase64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(keyBase64, "base64");
  const toSign = `${msgId}.${epochSeconds}.${body}`;
  const hmac = createHmac("sha256", key);
  hmac.update(toSign);
  return `v1,${hmac.digest("base64")}`;
}

function buildSvixHeaders(
  secret: string,
  msgId: string,
  epochSeconds: number,
  body: string,
  previousSecret?: string,
  previousSecretExpiresAt?: Date,
): Record<string, string> {
  const signatures: string[] = [svixSign(secret, msgId, epochSeconds, body)];

  if (
    previousSecret &&
    previousSecretExpiresAt &&
    previousSecretExpiresAt.getTime() > Date.now()
  ) {
    signatures.push(svixSign(previousSecret, msgId, epochSeconds, body));
  }

  const sigHeader = signatures.join(" ");
  return {
    "svix-id": msgId,
    "svix-timestamp": String(epochSeconds),
    "svix-signature": sigHeader,
    "webhook-id": msgId,
    "webhook-timestamp": String(epochSeconds),
    "webhook-signature": sigHeader,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sign(
  secret: string,
  body: string,
  overrides?: { msgId?: string; epochSeconds?: number },
) {
  const msgId = overrides?.msgId ?? `msg_${randomBytes(8).toString("hex")}`;
  const epochSeconds = overrides?.epochSeconds ?? Math.floor(Date.now() / 1000);
  const headers = buildSvixHeaders(secret, msgId, epochSeconds, body);
  return { msgId, epochSeconds, headers };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Svix signing", () => {
  it("standardwebhooks Webhook.verify() accepts our signature", () => {
    const secret = generateSvixSecret();
    const body = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString() });

    const { msgId, epochSeconds, headers } = sign(secret, body);

    const wh = new StandardWebhook(secret);
    expect(() =>
      wh.verify(body, {
        "webhook-id": msgId,
        "webhook-timestamp": String(epochSeconds),
        "webhook-signature": headers["webhook-signature"]!,
      }),
    ).not.toThrow();
  });

  it("resend.webhooks.verify() accepts our Svix signature", () => {
    const secret = generateSvixSecret();
    const body = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString() });

    const { headers } = sign(secret, body);

    const resend = new Resend("test_key");

    expect(() =>
      resend.webhooks.verify({
        payload: body,
        headers: {
          id: headers["svix-id"]!,
          timestamp: headers["svix-timestamp"]!,
          signature: headers["svix-signature"]!,
        },
        webhookSecret: secret,
      }),
    ).not.toThrow();
  });

  it("rejects a tampered body", () => {
    const secret = generateSvixSecret();
    const body = JSON.stringify({ type: "email.sent" });
    const { headers } = sign(secret, body);

    const resend = new Resend("test_key");

    expect(() =>
      resend.webhooks.verify({
        payload: body + "tampered",
        headers: {
          id: headers["svix-id"]!,
          timestamp: headers["svix-timestamp"]!,
          signature: headers["svix-signature"]!,
        },
        webhookSecret: secret,
      }),
    ).toThrow();
  });

  it("rejects a wrong secret", () => {
    const secret = generateSvixSecret();
    const wrongSecret = generateSvixSecret();
    const body = JSON.stringify({ type: "email.sent" });
    const { headers } = sign(secret, body);

    const wh = new StandardWebhook(wrongSecret);
    expect(() =>
      wh.verify(body, {
        "webhook-id": headers["webhook-id"]!,
        "webhook-timestamp": headers["webhook-timestamp"]!,
        "webhook-signature": headers["webhook-signature"]!,
      }),
    ).toThrow();
  });

  describe("secret rotation", () => {
    it("both new and previous secret verify the same message during grace period", () => {
      const previousSecret = generateSvixSecret();
      const newSecret = generateSvixSecret();
      const body = JSON.stringify({ type: "email.delivered" });

      const msgId = `msg_${randomBytes(8).toString("hex")}`;
      const epochSeconds = Math.floor(Date.now() / 1000);

      const previousSecretExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const headers = buildSvixHeaders(
        newSecret,
        msgId,
        epochSeconds,
        body,
        previousSecret,
        previousSecretExpiresAt,
      );

      // The svix-signature header contains two space-separated signatures.
      const signatures = headers["svix-signature"]!.split(" ");
      expect(signatures).toHaveLength(2);

      // Receiver still has the old secret — should verify using one of the sigs.
      const oldWh = new StandardWebhook(previousSecret);
      expect(() =>
        oldWh.verify(body, {
          "webhook-id": msgId,
          "webhook-timestamp": String(epochSeconds),
          "webhook-signature": headers["webhook-signature"]!,
        }),
      ).not.toThrow();

      // Receiver updated to new secret — should also verify.
      const newWh = new StandardWebhook(newSecret);
      expect(() =>
        newWh.verify(body, {
          "webhook-id": msgId,
          "webhook-timestamp": String(epochSeconds),
          "webhook-signature": headers["webhook-signature"]!,
        }),
      ).not.toThrow();
    });

    it("expired previous secret does not appear in headers", () => {
      const previousSecret = generateSvixSecret();
      const newSecret = generateSvixSecret();
      const body = JSON.stringify({ type: "email.bounced" });

      const msgId = `msg_${randomBytes(8).toString("hex")}`;
      const epochSeconds = Math.floor(Date.now() / 1000);

      // Expired — 1 ms in the past
      const expiredAt = new Date(Date.now() - 1);
      const headers = buildSvixHeaders(newSecret, msgId, epochSeconds, body, previousSecret, expiredAt);

      // Only one signature should be in the header
      const signatures = headers["svix-signature"]!.split(" ");
      expect(signatures).toHaveLength(1);
    });
  });
});

describe("toResendPayload", () => {
  const now = new Date().toISOString();

  it("maps email.sent to BaseEmailEventData shape", () => {
    const result = toResendPayload(
      "email.sent",
      {
        id: "em_1",
        status: "SENT",
        from: "a@b.com",
        to: ["u@example.com"],
        subject: "Hi",
        occurredAt: now,
      },
      now,
    );

    expect(result.type).toBe("email.sent");
    expect(result.created_at).toBe(now);
    expect(result.data).toMatchObject({
      email_id: "em_1",
      from: "a@b.com",
      to: ["u@example.com"],
      subject: "Hi",
    });
  });

  it("maps email.bounced to include bounce field", () => {
    const result = toResendPayload(
      "email.bounced",
      {
        id: "em_2",
        status: "BOUNCED",
        from: "a@b.com",
        to: ["u@example.com"],
        occurredAt: now,
        bounce: { type: "Permanent", subType: "NoEmail", message: "550" },
      },
      now,
    );

    expect(result.data).toMatchObject({
      email_id: "em_2",
      bounce: { type: "Permanent", subType: "NoEmail", message: "550" },
    });
  });

  it("maps suppression.added to Resend suppression shape", () => {
    const result = toResendPayload(
      "suppression.added",
      {
        id: "sup_1",
        email: "b@c.com",
        reason: "Bounce",
        source: null,
        createdAt: now,
      },
      now,
    );

    expect(result.type).toBe("suppression.added");
    expect(result.data).toMatchObject({
      id: "sup_1",
      email: "b@c.com",
      origin: "bounce",
      source_id: null,
    });
  });

  it("maps suppression.removed correctly", () => {
    const result = toResendPayload(
      "suppression.removed",
      {
        id: "sup_2",
        email: "c@d.com",
        reason: "Manual",
        source: "manual_add",
        createdAt: now,
      },
      now,
    );

    expect(result.data).toMatchObject({
      origin: "manual",
      source_id: "manual_add",
    });
  });

  it("maps email.scheduled normally (no extra fields)", () => {
    const result = toResendPayload(
      "email.scheduled",
      {
        id: "em_3",
        status: "SCHEDULED",
        from: "a@b.com",
        to: ["u@example.com"],
        subject: "Scheduled",
        occurredAt: now,
      },
      now,
    );
    expect(result.type).toBe("email.scheduled");
    expect(result.data).toHaveProperty("email_id", "em_3");
  });

  it("maps email.clicked to include click fields", () => {
    const result = toResendPayload(
      "email.clicked",
      {
        id: "em_4",
        status: "CLICKED",
        from: "a@b.com",
        to: ["u@example.com"],
        occurredAt: now,
        click: { timestamp: now, url: "https://x.com", userAgent: "curl/1", ip: "1.2.3.4" },
      },
      now,
    );
    expect(result.data).toMatchObject({
      url: "https://x.com",
      user_agent: "curl/1",
    });
  });

  it("returns unknown events with raw data", () => {
    const result = toResendPayload("webhook.test", { test: true }, now);
    expect(result.type).toBe("webhook.test");
    expect(result.data).toMatchObject({ test: true });
  });
});
