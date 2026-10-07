import type { Prisma } from "@prisma/client";
import { db } from "~/server/db";
import { sendEmail } from "~/server/service/email-service";
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

export function registerEmailRoutes(app: ResendApp): void {
  // POST /emails — send (or schedule) one email through the native pipeline.
  app.post("/emails", async (c) => {
    const team = c.var.team;
    const input = resendSendEmailSchema.parse(await readJsonBody(c));
    const content = await toEmailContent(input, (idOrAlias) =>
      resolveTemplateId(team.id, idOrAlias),
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
}
