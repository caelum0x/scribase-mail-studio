import { EmailStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  NO_REPEAT,
  evaluateRepeatEvent,
  eventRecipients,
} from "./email-event-dedupe";

const bounce = (type: string, ...emails: string[]) => ({
  bounceType: type,
  bouncedRecipients: emails.map((emailAddress) => ({ emailAddress })),
});
const complaint = (...emails: string[]) => ({
  complainedRecipients: emails.map((emailAddress) => ({ emailAddress })),
});
const delivery = (...emails: string[]) => ({ recipients: emails });

describe("eventRecipients", () => {
  it("reads recipients per status, lowercased", () => {
    expect(
      eventRecipients(EmailStatus.BOUNCED, bounce("Permanent", "A@x.com")),
    ).toEqual(["a@x.com"]);
    expect(
      eventRecipients(EmailStatus.COMPLAINED, complaint("b@x.com")),
    ).toEqual(["b@x.com"]);
    expect(eventRecipients(EmailStatus.DELIVERED, delivery("c@x.com"))).toEqual(
      ["c@x.com"],
    );
    expect(eventRecipients(EmailStatus.DELIVERED, null)).toBeNull();
    expect(eventRecipients(EmailStatus.OPENED, delivery("c@x.com"))).toBeNull();
  });
});

describe("evaluateRepeatEvent", () => {
  it("passes the first event through", () => {
    expect(
      evaluateRepeatEvent(EmailStatus.BOUNCED, bounce("Permanent", "a@x"), []),
    ).toEqual(NO_REPEAT);
  });

  it("skips the same bounce seen by the other source", () => {
    expect(
      evaluateRepeatEvent(EmailStatus.BOUNCED, bounce("Permanent", "a@x"), [
        bounce("Permanent", "A@x"),
      ]),
    ).toEqual({ skip: true, repeat: true, hardBounceUpgrade: false });
  });

  it("skips repeated complaints and deliveries for the same recipient", () => {
    expect(
      evaluateRepeatEvent(EmailStatus.COMPLAINED, complaint("a@x"), [
        complaint("a@x"),
      ]).skip,
    ).toBe(true);
    expect(
      evaluateRepeatEvent(EmailStatus.DELIVERED, delivery("a@x"), [
        delivery("a@x"),
      ]).skip,
    ).toBe(true);
  });

  it("lets a new recipient through without recounting usage", () => {
    expect(
      evaluateRepeatEvent(EmailStatus.DELIVERED, delivery("b@x"), [
        delivery("a@x"),
      ]),
    ).toEqual({ skip: false, repeat: true, hardBounceUpgrade: false });
  });

  it("upgrades a transient bounce to a permanent one", () => {
    expect(
      evaluateRepeatEvent(EmailStatus.BOUNCED, bounce("Permanent", "a@x"), [
        bounce("Transient", "a@x"),
      ]),
    ).toEqual({ skip: false, repeat: true, hardBounceUpgrade: true });
    expect(
      evaluateRepeatEvent(EmailStatus.BOUNCED, bounce("Transient", "a@x"), [
        bounce("Permanent", "a@x"),
      ]).skip,
    ).toBe(true);
  });

  it("treats prior events without recipients as covering everyone", () => {
    expect(
      evaluateRepeatEvent(EmailStatus.COMPLAINED, complaint("a@x"), [{}]).skip,
    ).toBe(true);
    expect(
      evaluateRepeatEvent(EmailStatus.COMPLAINED, {}, [complaint("a@x")]).skip,
    ).toBe(true);
  });
});
