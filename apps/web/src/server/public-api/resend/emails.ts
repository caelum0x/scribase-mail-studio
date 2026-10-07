import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "~/server/db";
import { sendEmail, sendBulkEmails, updateEmail, cancelEmail } from "~/server/service/email-service";
import { IdempotencyService } from "~/server/service/idempotency-service";
import { readJsonBody, type ResendApp } from "./app";
import {
  resendEmailSelect,
  toResendEmail,
  toResendEmailListItem,
} from "./email-presenter";
import { resendSendEmailSchema, toEmailContent } from "./email-schema";
import { ResendApiError } from "./errors";
import { mapList, paginate, parseCursorParams } from "./pagination";
import { parseResendScheduledAt } from "./email-schema";

/** Resolve a Resend template reference (id or alias) to a team template id. */
export async function resolveTemplateId(
  teamId: number,
  idOrAlias: string,
): Promise<string> {
  const template = await db.template.findFirst({
    where: { teamId, OR: [{ id: idOrAlias }, { alias: idOrAlias }] },
    select: { id: true },
  });
  if (!template) {
    throw new ResendApiError("not_found", "Template not found");
  }
  return template.id;
}

type TeamScope = { id: number; apiKey: { domainId: number | null } };

function emailScope(team: TeamScope): Prisma.EmailWhereInput {
  return {
    teamId: team.id,
    ...(team.apiKey.domainId !== null ? { domainId: team.apiKey.domainId } : {}),
  };
}

/**
 * Build a filterTopicRecipients helper scoped to the given teamId.
 * Looks up contacts across the team's contact books and filters out recipients
 * with an OPT_OUT subscription for the topic (or no OPT_IN if the topic
 * default is OPT_OUT).
 */
async function filterTopicRecipients(opts: {
  topicId: string;
  teamId: number;
  to: string[];
  cc: string[];
  bcc: string[];
}): Promise<{ to: string[]; cc: string[]; bcc: string[] }> {
  const { topicId, teamId, to, cc, bcc } = opts;

  const topic = await db.topic.findFirst({
    where: { id: topicId, teamId },
    select: { id: true, defaultSubscription: true },
  });
  if (!topic) {
    throw new ResendApiError("not_found", `Topic '${topicId}' not found.`);
  }

  const allRecipients = [...new Set([...to, ...cc, ...bcc])];
  if (allRecipients.length === 0) return { to, cc, bcc };

  // Find contacts by email across all of this team's contact books.
  const contacts = await db.contact.findMany({
    where: {
      email: { in: allRecipients },
      contactBook: { teamId },
    },
    select: {
      email: true,
      topics: {
        where: { topicId },
        select: { subscription: true },
      },
    },
  });

  // Build a set of blocked emails.
  const blocked = new Set<string>();
  const contactsByEmail = new Map(contacts.map((c) => [c.email.toLowerCase(), c]));

  for (const email of allRecipients) {
    const contact = contactsByEmail.get(email.toLowerCase());
    if (topic.defaultSubscription === "OPT_OUT") {
      // Block unless the contact explicitly opted in.
      if (!contact || contact.topics.length === 0 || contact.topics[0]!.subscription !== "OPT_IN") {
        blocked.add(email.toLowerCase());
      }
    } else {
      // Block if the contact explicitly opted out.
      if (contact && contact.topics.length > 0 && contact.topics[0]!.subscription === "OPT_OUT") {
        blocked.add(email.toLowerCase());
      }
    }
  }

  const filter = (list: string[]) =>
    list.filter((e) => !blocked.has(e.toLowerCase()));

  return { to: filter(to), cc: filter(cc), bcc: filter(bcc) };
}

/**
 * x-batch-validation modes.
 * strict  – reject the entire batch if any single email fails validation.
 * permissive (default) – skip invalid emails, return partial results.
 */
type BatchValidationMode = "strict" | "permissive";

function parseBatchValidationMode(header: string | undefined): BatchValidationMode {
  if (header === "strict") return "strict";
  return "permissive";
}

export function registerEmailRoutes(app: ResendApp): void {
  // POST /emails — send (or schedule) one email through the native pipeline.
  app.post("/emails", async (c) => {
    const team = c.var.team;
    const input = resendSendEmailSchema.parse(await readJsonBody(c));
    const content = await toEmailContent(
      input,
      (idOrAlias) => resolveTemplateId(team.id, idOrAlias),
      undefined,
      input.topic_id
        ? (filterOpts) =>
            filterTopicRecipients({ ...filterOpts, teamId: team.id })
        : undefined,
    );

    const result = await IdempotencyService.withIdempotency<
      typeof input,
      { id: string }
    >({
      teamId: team.id,
      idemKey: c.req.header("Idempotency-Key") || undefined,
      payload: input,
      operation: async () => {
        const email = await sendEmail({
          ...content,
          teamId: team.id,
          apiKeyId: team.apiKeyId,
        });
        return { id: email.id };
      },
      extractEmailIds: (res) => [res.id],
      formatCachedResponse: (ids) => ({ id: ids[0] ?? "" }),
      logContext: "resend email send",
    });

    return c.json(result, 200);
  });

  // POST /emails/batch — batch send up to 100 emails.
  app.post("/emails/batch", async (c) => {
    const team = c.var.team;
    const body = await readJsonBody(c);
    const validationMode = parseBatchValidationMode(
      c.req.header("x-batch-validation"),
    );

    if (!Array.isArray(body)) {
      throw new ResendApiError(
        "validation_error",
        "Request body must be a JSON array.",
      );
    }
    if (body.length === 0) {
      throw new ResendApiError(
        "validation_error",
        "Batch must contain at least one email.",
      );
    }
    if (body.length > 100) {
      throw new ResendApiError(
        "validation_error",
        "Batch cannot exceed 100 emails.",
      );
    }

    // Parse and validate each item.
    const parseResults = body.map((item, i) => {
      try {
        return { ok: true as const, index: i, value: resendSendEmailSchema.parse(item) };
      } catch (err: unknown) {
        return { ok: false as const, index: i, error: err };
      }
    });

    if (validationMode === "strict") {
      const firstError = parseResults.find((r) => !r.ok);
      if (firstError && !firstError.ok) {
        throw firstError.error instanceof Error
          ? firstError.error
          : new ResendApiError("validation_error", `Email at index ${firstError.index} is invalid.`);
      }
    }

    // Map valid inputs to EmailContent, skipping failures in permissive mode.
    const emailsToSend: Array<{
      content: Awaited<ReturnType<typeof toEmailContent>>;
      index: number;
    }> = [];

    for (const result of parseResults) {
      if (!result.ok) continue; // permissive: skip
      try {
        const content = await toEmailContent(
          result.value,
          (idOrAlias) => resolveTemplateId(team.id, idOrAlias),
          undefined,
          result.value.topic_id
            ? (filterOpts) =>
                filterTopicRecipients({ ...filterOpts, teamId: team.id })
            : undefined,
        );
        emailsToSend.push({ content, index: result.index });
      } catch (err) {
        if (validationMode === "strict") throw err;
        // permissive: skip this email
      }
    }

    const idemKey = c.req.header("Idempotency-Key") || undefined;

    const responseData = await IdempotencyService.withIdempotency({
      teamId: team.id,
      idemKey,
      payload: body,
      operation: async () => {
        const emails = await sendBulkEmails(
          emailsToSend.map(({ content }) => ({
            ...content,
            teamId: team.id,
            apiKeyId: team.apiKeyId,
          })),
        );
        return emails.map((e) => ({ id: e.id }));
      },
      extractEmailIds: (items: { id: string }[]) => items.map((i) => i.id),
      formatCachedResponse: (ids: string[]) => ids.map((id) => ({ id })),
      logContext: "resend batch email send",
    });

    return c.json({ data: responseData as { id: string }[] }, 200);
  });

  // GET /emails — cursor-paginated list, newest first.
  app.get("/emails", async (c) => {
    const team = c.var.team;
    const params = parseCursorParams(c.req.query());
    const scope = emailScope(team);

    const list = await paginate(params, {
      resolveCursor: (id) =>
        db.email.findFirst({
          where: { ...scope, id },
          select: { id: true, createdAt: true },
        }),
      fetch: ({ cursor, orderBy, take }) =>
        db.email.findMany({
          where: cursor ? { AND: [scope, cursor] } : scope,
          orderBy,
          take,
          select: resendEmailSelect,
        }),
    });

    return c.json(mapList(list, toResendEmailListItem), 200);
  });

  // GET /emails/:id — retrieve one email.
  app.get("/emails/:id", async (c) => {
    const team = c.var.team;
    const email = await db.email.findFirst({
      where: { ...emailScope(team), id: c.req.param("id") },
      select: resendEmailSelect,
    });
    if (!email) {
      throw new ResendApiError("not_found", "Email not found");
    }
    return c.json(toResendEmail(email), 200);
  });

  // PATCH /emails/:id — reschedule a scheduled email.
  app.patch("/emails/:id", async (c) => {
    const team = c.var.team;
    const emailId = c.req.param("id");

    // Verify the email exists and belongs to this team/domain scope.
    const existing = await db.email.findFirst({
      where: { ...emailScope(team), id: emailId },
      select: { id: true, latestStatus: true },
    });
    if (!existing) {
      throw new ResendApiError("not_found", "Email not found");
    }
    if (existing.latestStatus !== "SCHEDULED") {
      throw new ResendApiError(
        "validation_error",
        "Only scheduled emails can be rescheduled.",
      );
    }

    const body = z
      .object({ scheduled_at: z.string().min(1) })
      .strict()
      .parse(await readJsonBody(c));

    const scheduledAt = parseResendScheduledAt(body.scheduled_at);

    await updateEmail(emailId, { scheduledAt: scheduledAt.toISOString() });

    return c.json({ object: "email", id: emailId }, 200);
  });

  // POST /emails/:id/cancel — cancel a scheduled email.
  app.post("/emails/:id/cancel", async (c) => {
    const team = c.var.team;
    const emailId = c.req.param("id");

    const existing = await db.email.findFirst({
      where: { ...emailScope(team), id: emailId },
      select: { id: true, latestStatus: true },
    });
    if (!existing) {
      throw new ResendApiError("not_found", "Email not found");
    }
    if (existing.latestStatus !== "SCHEDULED") {
      throw new ResendApiError(
        "validation_error",
        "Only scheduled emails can be cancelled.",
      );
    }

    await cancelEmail(emailId);

    return c.json({ object: "email", id: emailId }, 200);
  });
}
