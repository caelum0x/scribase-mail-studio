import { env } from "~/env";
import { UseSend } from "usesend-js";
import { isSelfHosted } from "~/utils/common";
import { db } from "./db";
import { getDomains } from "./service/domain-service";
import { sendEmail } from "./service/email-service";
import { logger } from "./logger/log";
import { getEmailProvider } from "./provider";
import { randomUUID } from "crypto";
import { renderOtpEmail, renderTeamInviteEmail } from "./email-templates";

let usesend: UseSend | undefined;

const getClient = () => {
  if (!usesend) {
    usesend = new UseSend(env.USESEND_API_KEY ?? env.UNSEND_API_KEY);
  }
  return usesend;
};

export async function sendSignUpEmail(
  email: string,
  token: string,
  url: string,
) {
  const { host } = new URL(url);

  if (env.NODE_ENV === "development") {
    logger.info({ email, url, token }, "Sending sign in email");
    return;
  }

  const subject = "Sign in to Scribase Mail";

  // Use jsx-email template for beautiful HTML
  const html = await renderOtpEmail({
    otpCode: token.toUpperCase(),
    loginUrl: url,
    hostName: host,
  });

  // Fallback text version
  const text = `Hey,\n\nYou can sign in to Scribase Mail by clicking the below URL:\n${url}\n\nYou can also use this OTP: ${token}\n\nThanks,\nThe Scribase team`;

  await sendMail(email, subject, text, html);
}

export async function sendTeamInviteEmail(
  email: string,
  url: string,
  teamName: string,
) {
  const { host } = new URL(url);

  if (env.NODE_ENV === "development") {
    logger.info({ email, url, teamName }, "Sending team invite email");
    return;
  }

  const subject = "You have been invited to join Scribase Mail";

  // Use jsx-email template for beautiful HTML
  const html = await renderTeamInviteEmail({
    teamName,
    inviteUrl: url,
  });

  // Fallback text version
  const text = `Hey,\n\nYou have been invited to join the team ${teamName} on Scribase Mail.\n\nYou can accept the invitation by clicking the below URL:\n${url}\n\nThanks,\nThe Scribase team`;

  await sendMail(email, subject, text, html);
}

export async function sendSubscriptionConfirmationEmail(email: string) {
  if (!env.FOUNDER_EMAIL) {
    logger.error("FOUNDER_EMAIL not configured");
    return;
  }

  const subject = "Thanks for subscribing to Scribase Mail";
  const text = `Hey,\n\nThanks for subscribing to Scribase Mail. Reply to this email any time and the team will get back to you.\n\nThe Scribase team`;
  const html = text.replace(/\n/g, "<br />");

  await sendMail(email, subject, text, html, undefined, env.FOUNDER_EMAIL);
}

/**
 * System emails (sign-in codes, invites, notifications) go straight to the
 * provider relay from FROM_EMAIL (in cloud and self-hosted mode), so a fresh
 * install can sign users in before any team domain is verified. Returns false when the relay is unavailable.
 */
async function sendSystemMail({
  email,
  subject,
  text,
  html,
  replyTo,
  from,
}: {
  email: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  from: string;
}): Promise<boolean> {
  try {
    const provider = getEmailProvider();
    await provider.ensureApprovedSender(from);
    const domain = from.split("@")[1]?.replace(/>$/, "") ?? "scribase.mail";
    await provider.sendRawEmail({
      from,
      to: [email],
      replyTo: replyTo ? [replyTo] : undefined,
      subject,
      text,
      html,
      messageId: `${randomUUID()}@${domain}`,
    });
    logger.info({ subject }, "System email sent via provider relay");
    return true;
  } catch (error) {
    logger.error(
      { err: error, subject },
      "Failed to send system email via provider relay",
    );
    return false;
  }
}

export async function sendMail(
  email: string,
  subject: string,
  text: string,
  html: string,
  replyTo?: string,
  fromOverride?: string,
) {
  // Cloud and self-hosted both relay system mail through the provider; the
  // upstream useSend cloud client is never the first choice.
  if (
    env.FROM_EMAIL &&
    (await sendSystemMail({
      email,
      subject,
      text,
      html,
      replyTo,
      from: fromOverride ?? env.FROM_EMAIL,
    }))
  ) {
    return;
  }

  if (isSelfHosted()) {
    logger.info("Sending email using self hosted");
    /* 
      Self hosted so checking if we can send using one of the available domain
      Assuming self hosted will have only one team
      TODO: fix this
     */
    const team = await db.team.findFirst({});
    if (!team) {
      logger.error("No team found");
      return;
    }

    const domains = await getDomains(team.id);

    if (domains.length === 0 || !domains[0]) {
      logger.error("No domains found");
      return;
    }

    const availableDomains = domains.map((d) => d.name);
    const domain = domains[0];

    const candidateFroms = [
      fromOverride,
      env.FROM_EMAIL,
      `hello@${domain.name}`,
    ].filter((value): value is string => Boolean(value));

    const selectedFrom =
      candidateFroms.find((address) => {
        const domainPart = address.split("@")[1];
        return domainPart ? availableDomains.includes(domainPart) : false;
      }) ?? `hello@${domain.name}`;

    await sendEmail({
      teamId: team.id,
      to: email,
      from: selectedFrom,
      subject,
      text,
      html,
      replyTo,
    });
  } else if (env.UNSEND_API_KEY && (env.FROM_EMAIL || fromOverride)) {
    const fromAddress = fromOverride ?? env.FROM_EMAIL!;
    const resp = await getClient().emails.send({
      to: email,
      from: fromAddress,
      subject,
      text,
      html,
      replyTo,
    });

    if (resp.data) {
      logger.info("Email sent using the Scribase Mail API");
      return;
    } else {
      logger.error(
        { code: resp.error?.code, message: resp.error?.message },
        "Error sending email using the Scribase Mail API",
      );
    }
  } else {
    throw new Error("USESEND_API_KEY/UNSEND_API_KEY not found");
  }
}
