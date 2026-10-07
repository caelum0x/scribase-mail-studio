/**
 * Test recipient service — simulated delivery/bounce/complaint sinks (Wave 2 B3).
 *
 * Test addresses mimic Resend's `delivered@resend.dev`, `bounced@resend.dev`
 * and `complained@resend.dev`.  Our equivalents are:
 *
 *   delivered@test.scribase.com
 *   bounced@test.scribase.com
 *   complained@test.scribase.com
 *
 * When a send detects one of these addresses it skips the OCI SMTP relay and
 * instead inserts the corresponding event directly.
 */
import { EmailStatus } from "@prisma/client";
import { db } from "../db";

const TEST_DOMAIN = "test.scribase.com";

export type TestRecipientAction = "DELIVERED" | "BOUNCED" | "COMPLAINED";

export function isTestRecipient(email: string): boolean {
  return email.toLowerCase().endsWith(`@${TEST_DOMAIN}`);
}

export function getTestRecipientAction(
  email: string,
): TestRecipientAction | null {
  const lower = email.toLowerCase();
  if (lower === `delivered@${TEST_DOMAIN}`) return "DELIVERED";
  if (lower === `bounced@${TEST_DOMAIN}`) return "BOUNCED";
  if (lower === `complained@${TEST_DOMAIN}`) return "COMPLAINED";
  return null;
}

const ACTION_TO_STATUS: Record<TestRecipientAction, EmailStatus> = {
  DELIVERED: EmailStatus.DELIVERED,
  BOUNCED: EmailStatus.BOUNCED,
  COMPLAINED: EmailStatus.COMPLAINED,
};

/**
 * Simulate delivery outcome for a test recipient.  Updates the email record
 * and inserts an EmailEvent without touching the OCI relay.
 */
export async function simulateTestRecipientOutcome(
  emailId: string,
  teamId: number,
  action: TestRecipientAction,
): Promise<void> {
  const status = ACTION_TO_STATUS[action];

  await db.$transaction([
    db.email.update({
      where: { id: emailId },
      data: { latestStatus: status },
    }),
    db.emailEvent.create({
      data: {
        emailId,
        teamId,
        status,
        data: { simulated: true, action },
      },
    }),
  ]);
}
