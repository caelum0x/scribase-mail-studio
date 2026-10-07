/**
 * Resend-compatible public webhooks API.
 *
 * POST   /webhooks                        — create
 * GET    /webhooks                        — list
 * GET    /webhooks/:id                    — get
 * PATCH  /webhooks/:id                    — update
 * DELETE /webhooks/:id                    — delete
 * POST   /webhooks/:id/signing-secret/rotate — rotate signing secret
 */
import { z } from "zod";
import { WebhookSignatureFormat, WebhookStatus } from "@prisma/client";
import { WebhookEvents } from "@usesend/lib/src/webhook/webhook-events";
import { WebhookService } from "~/server/service/webhook-service";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";

const EVENT_TYPE_VALUES = WebhookEvents as unknown as [string, ...string[]];

const createWebhookSchema = z
  .object({
    url: z.string().url({ message: "Invalid webhook URL." }),
    description: z.string().optional(),
    events: z.array(z.enum(EVENT_TYPE_VALUES)).optional(),
    domain_ids: z.array(z.number().int().positive()).optional(),
  })
  .strict();

const updateWebhookSchema = z
  .object({
    url: z.string().url().optional(),
    description: z.string().nullable().optional(),
    events: z.array(z.enum(EVENT_TYPE_VALUES)).optional(),
    domain_ids: z.array(z.number().int().positive()).optional(),
  })
  .strict();

function formatWebhook(webhook: {
  id: string;
  url: string;
  description: string | null;
  secret: string;
  eventTypes: string[];
  status: WebhookStatus;
  signatureFormat: WebhookSignatureFormat;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    object: "webhook",
    id: webhook.id,
    url: webhook.url,
    description: webhook.description,
    events: webhook.eventTypes,
    status: webhook.status.toLowerCase(),
    signing_secret: webhook.secret,
    signature_format: webhook.signatureFormat.toLowerCase(),
    created_at: webhook.createdAt.toISOString(),
    updated_at: webhook.updatedAt.toISOString(),
  };
}

export function registerWebhookRoutes(app: ResendApp): void {
  // POST /webhooks — create
  app.post("/webhooks", async (c) => {
    const team = c.var.team;
    const raw = createWebhookSchema.parse(await readJsonBody(c));

    const webhook = await WebhookService.createWebhook({
      teamId: team.id,
      userId: team.apiKey ? (team as unknown as { userId?: number }).userId ?? 0 : 0,
      url: raw.url,
      description: raw.description,
      eventTypes: raw.events ?? [],
      domainIds: raw.domain_ids,
      signatureFormat: WebhookSignatureFormat.SVIX,
    });

    return c.json(formatWebhook(webhook), 201);
  });

  // GET /webhooks — list
  app.get("/webhooks", async (c) => {
    const team = c.var.team;
    const webhooks = await WebhookService.listWebhooks(team.id);
    return c.json(
      {
        object: "list",
        data: webhooks.map(formatWebhook),
      },
      200,
    );
  });

  // GET /webhooks/:id — get one
  app.get("/webhooks/:id", async (c) => {
    const team = c.var.team;
    const webhook = await WebhookService.getWebhook({
      id: c.req.param("id"),
      teamId: team.id,
    });
    return c.json(formatWebhook(webhook), 200);
  });

  // PATCH /webhooks/:id — update
  app.patch("/webhooks/:id", async (c) => {
    const team = c.var.team;
    const raw = updateWebhookSchema.parse(await readJsonBody(c));

    const webhook = await WebhookService.updateWebhook({
      id: c.req.param("id"),
      teamId: team.id,
      url: raw.url,
      description: raw.description,
      eventTypes: raw.events,
      domainIds: raw.domain_ids,
    });

    return c.json(formatWebhook(webhook), 200);
  });

  // DELETE /webhooks/:id — delete
  app.delete("/webhooks/:id", async (c) => {
    const team = c.var.team;
    await WebhookService.deleteWebhook({
      id: c.req.param("id"),
      teamId: team.id,
    });
    return c.json({ object: "webhook", id: c.req.param("id"), deleted: true }, 200);
  });

  // POST /webhooks/:id/signing-secret/rotate — rotate signing secret
  app.post("/webhooks/:id/signing-secret/rotate", async (c) => {
    const team = c.var.team;
    const webhook = await WebhookService.rotateSigningSecret({
      id: c.req.param("id"),
      teamId: team.id,
    });

    return c.json(
      {
        object: "webhook_signing_secret",
        webhook_id: webhook.id,
        signing_secret: webhook.secret,
      },
      200,
    );
  });

  // GET /webhooks/:id/events — list webhook call events (Resend shape)
  app.get("/webhooks/:id/events", async (c) => {
    const team = c.var.team;
    // Verify the webhook belongs to this team
    await WebhookService.getWebhook({ id: c.req.param("id"), teamId: team.id });

    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.min(Number(limitRaw) || 20, 100) : 20;
    const cursor = c.req.query("after") ?? undefined;

    const { items, nextCursor } = await WebhookService.listWebhookCalls({
      teamId: team.id,
      webhookId: c.req.param("id"),
      limit,
      cursor,
    });

    return c.json(
      {
        object: "list",
        has_more: nextCursor !== null,
        data: items.map((call) => ({
          id: call.id,
          type: call.type,
          created_at: call.createdAt.toISOString(),
          status: call.status.toLowerCase(),
          next_attempt_at: call.nextAttemptAt?.toISOString() ?? null,
          response_status: call.responseStatus ?? null,
          response_time_ms: call.responseTimeMs ?? null,
        })),
      },
      200,
    );
  });
}
