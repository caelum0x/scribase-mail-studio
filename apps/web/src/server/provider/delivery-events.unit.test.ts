import { describe, expect, it } from "vitest";
import { mapDeliveryLogToMailEvent } from "./delivery-events";
import type { ProviderDeliveryEvent } from "./types";

const email = { id: "em_1", providerMessageId: "em_1@acme.test" };

function record(
  overrides: Partial<ProviderDeliveryEvent> = {},
): ProviderDeliveryEvent {
  return {
    id: "rec-1",
    action: "relay",
    timestamp: new Date("2026-10-07T10:00:00Z"),
    messageId: "em_1@acme.test",
    recipient: "user@example.com",
    sender: "hello@acme.test",
    smtpStatus: "250 2.1.5 Recipient ok",
    recipientMailServer: "mx.example.com (192.0.2.10)",
    processingTimeMs: 20,
    ...overrides,
  };
}

describe("mapDeliveryLogToMailEvent", () => {
  it("maps relay to a Delivery event", () => {
    expect(mapDeliveryLogToMailEvent(record(), email)).toEqual({
      eventType: "Delivery",
      mail: {
        timestamp: "2026-10-07T10:00:00.000Z",
        emailId: "em_1",
        messageId: "em_1@acme.test",
        source: "hello@acme.test",
        destination: ["user@example.com"],
      },
      delivery: {
        timestamp: "2026-10-07T10:00:00.000Z",
        processingTimeMillis: 20,
        recipients: ["user@example.com"],
        smtpResponse: "250 2.1.5 Recipient ok",
        reportingMTA: "mx.example.com (192.0.2.10)",
        remoteMtaIp: "192.0.2.10",
      },
    });
  });

  it("maps a hard bounce to a Permanent bounce with details", () => {
    const event = mapDeliveryLogToMailEvent(
      record({
        action: "bounce",
        bounceType: "hard",
        bounceCategory: "bad-mailbox",
        bounceCode: "5.1.1",
        smtpStatus: "550 5.1.1 unknown user",
      }),
      email,
    );
    expect(event).toMatchObject({
      eventType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "NoEmail",
        bouncedRecipients: [
          {
            emailAddress: "user@example.com",
            action: "failed",
            status: "5.1.1",
            diagnosticCode: "550 5.1.1 unknown user",
          },
        ],
        feedbackId: "rec-1",
      },
    });
  });

  it("maps soft and undetermined bounces", () => {
    const soft = mapDeliveryLogToMailEvent(
      record({
        action: "bounce",
        bounceType: "soft",
        bounceCategory: "quota-issues",
        bounceCode: undefined,
      }),
      email,
    );
    expect(soft?.bounce).toMatchObject({
      bounceType: "Transient",
      bounceSubType: "MailboxFull",
      bouncedRecipients: [{ status: "4.0.0" }],
    });

    const unknown = mapDeliveryLogToMailEvent(
      record({
        action: "bounce",
        bounceType: undefined,
        bounceCategory: "other",
        smtpStatus: "552 message too large",
      }),
      email,
    );
    expect(unknown?.bounce).toMatchObject({
      bounceType: "Undetermined",
      bounceSubType: "MessageTooLarge",
    });
  });

  it("maps complaints", () => {
    const event = mapDeliveryLogToMailEvent(
      record({
        action: "complaint",
        reportGeneratedTime: new Date("2026-10-07T11:00:00Z"),
      }),
      email,
    );
    expect(event).toMatchObject({
      eventType: "Complaint",
      complaint: {
        complainedRecipients: [{ emailAddress: "user@example.com" }],
        complaintFeedbackType: "abuse",
        feedbackId: "rec-1",
        arrivedDate: "2026-10-07T11:00:00.000Z",
      },
    });
  });

  it("ignores open, click, unsubscribe, unmatched emails and missing recipients", () => {
    for (const action of ["open", "click", "unsubscribe", "unknown"] as const) {
      expect(mapDeliveryLogToMailEvent(record({ action }), email)).toBeNull();
    }
    expect(mapDeliveryLogToMailEvent(record(), null)).toBeNull();
    expect(
      mapDeliveryLogToMailEvent(record({ recipient: undefined }), email),
    ).toBeNull();
  });
});
