/**
 * Resend /broadcasts routes — mapped onto existing Campaign model (Wave 2 B2).
 *
 * POST   /broadcasts             – create
 * GET    /broadcasts             – list
 * GET    /broadcasts/:id         – get
 * PATCH  /broadcasts/:id         – update (DRAFT only)
 * DELETE /broadcasts/:id         – delete
 * POST   /broadcasts/:id/send    – send immediately
 * POST   /broadcasts/:id/cancel  – cancel (pause)
 * POST   /broadcasts/:id/duplicate – duplicate
 *
 * `audience_id` → contactBookId (or segmentId for new segment model).
 * `topic_id`    → Campaign.topicId (opt-out enforcement via email-queue-service).
 */
import { z } from "zod";
import { CampaignStatus } from "@prisma/client";
import { db } from "~/server/db";
import {
  createCampaignFromApi,
  deleteCampaign,
  getCampaignForTeam,
  pauseCampaign,
  scheduleCampaign,
  sendCampaign,
} from "~/server/service/campaign-service";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";
import { paginate, parseCursorParams } from "./pagination";

// ── Schemas ──────────────────────────────────────────────────────────────────

const createBroadcastSchema = z.object({
  name: z.string().min(1),
  audience_id: z.string().min(1),
  from: z.string().min(1),
  subject: z.string().min(1),
  reply_to: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  bcc: z.union([z.string(), z.array(z.string())]).optional(),
  preview_text: z.string().optional(),
  html: z.string().optional(),
  content: z.string().optional(),
  topic_id: z.string().optional(),
  scheduled_at: z.string().optional(),
});

const updateBroadcastSchema = z.object({
  name: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  preview_text: z.string().optional(),
  html: z.string().optional(),
  topic_id: z.string().optional(),
  scheduled_at: z.string().optional(),
});

const sendBroadcastSchema = z.object({
  scheduled_at: z.string().optional(),
});

// ── Presenter ─────────────────────────────────────────────────────────────────

function presentBroadcast(campaign: {
  id: string;
  name: string;
  from: string;
  subject: string;
  previewText: string | null;
  contactBookId: string | null;
  status: CampaignStatus;
  scheduledAt: Date | null;
  topicId: string | null;
  total: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  bounced: number;
  complained: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    object: "broadcast" as const,
    id: campaign.id,
    name: campaign.name,
    audience_id: campaign.contactBookId,
    from: campaign.from,
    subject: campaign.subject,
    preview_text: campaign.previewText,
    topic_id: campaign.topicId,
    status: campaign.status.toLowerCase(),
    scheduled_at: campaign.scheduledAt?.toISOString() ?? null,
    metrics: {
      total: campaign.total,
      sent: campaign.sent,
      delivered: campaign.delivered,
      opened: campaign.opened,
      clicked: campaign.clicked,
      unsubscribed: campaign.unsubscribed,
      bounced: campaign.bounced,
      complained: campaign.complained,
    },
    created_at: campaign.createdAt.toISOString(),
    updated_at: campaign.updatedAt.toISOString(),
  };
}

const BROADCAST_SELECT = {
  id: true as const,
  name: true as const,
  from: true as const,
  subject: true as const,
  previewText: true as const,
  contactBookId: true as const,
  status: true as const,
  scheduledAt: true as const,
  topicId: true as const,
  total: true as const,
  sent: true as const,
  delivered: true as const,
  opened: true as const,
  clicked: true as const,
  unsubscribed: true as const,
  bounced: true as const,
  complained: true as const,
  createdAt: true as const,
  updatedAt: true as const,
};

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerBroadcastRoutes(app: ResendApp): void {
  // Create
  app.post("/broadcasts", async (c) => {
    const team = c.var.team;
    const body = createBroadcastSchema.parse(await readJsonBody(c));

    const campaign = await createCampaignFromApi({
      teamId: team.id,
      apiKeyId: team.apiKeyId,
      name: body.name,
      from: body.from,
      subject: body.subject,
      previewText: body.preview_text,
      html: body.html,
      content: body.content,
      contactBookId: body.audience_id,
      replyTo: body.reply_to,
      cc: body.cc,
      bcc: body.bcc,
    });

    // Set optional fields that createCampaignFromApi doesn't take.
    const updates: Record<string, unknown> = {};
    if (body.topic_id) updates.topicId = body.topic_id;
    if (body.scheduled_at) updates.scheduledAt = new Date(body.scheduled_at);
    if (Object.keys(updates).length > 0) {
      await db.campaign.update({ where: { id: campaign.id }, data: updates });
    }

    const full = await db.campaign.findUniqueOrThrow({
      where: { id: campaign.id },
      select: BROADCAST_SELECT,
    });

    return c.json(presentBroadcast(full), 201);
  });

  // List
  app.get("/broadcasts", async (c) => {
    const teamId = c.var.team.id;
    const params = parseCursorParams(c.req.query());

    const list = await paginate(params, {
      resolveCursor: (id) =>
        db.campaign.findFirst({
          where: { id, teamId, isApi: true },
          select: { id: true, createdAt: true },
        }),
      fetch: ({ cursor, orderBy, take }) =>
        db.campaign.findMany({
          where: cursor
            ? { AND: [{ teamId, isApi: true }, cursor] }
            : { teamId, isApi: true },
          orderBy,
          take,
          select: BROADCAST_SELECT,
        }),
    });

    return c.json(
      {
        object: "list" as const,
        has_more: list.has_more,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: (list.data as any[]).map(presentBroadcast),
      },
      200,
    );
  });

  // Get
  app.get("/broadcasts/:id", async (c) => {
    const campaign = await db.campaign.findFirst({
      where: { id: c.req.param("id"), teamId: c.var.team.id },
      select: BROADCAST_SELECT,
    });
    if (!campaign) throw new ResendApiError("not_found", "Broadcast not found");
    return c.json(presentBroadcast(campaign), 200);
  });

  // Update (DRAFT only; allow updating scheduled_at on SCHEDULED too)
  app.patch("/broadcasts/:id", async (c) => {
    const teamId = c.var.team.id;
    const id = c.req.param("id");
    const campaign = await db.campaign.findFirst({
      where: { id, teamId },
      select: { id: true, status: true },
    });
    if (!campaign) throw new ResendApiError("not_found", "Broadcast not found");
    if (
      campaign.status !== CampaignStatus.DRAFT &&
      campaign.status !== CampaignStatus.SCHEDULED
    ) {
      throw new ResendApiError(
        "validation_error",
        "Only DRAFT or SCHEDULED broadcasts can be updated",
      );
    }

    const body = updateBroadcastSchema.parse(await readJsonBody(c));
    const updated = await db.campaign.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.preview_text !== undefined ? { previewText: body.preview_text } : {}),
        ...(body.html !== undefined ? { html: body.html } : {}),
        ...(body.topic_id !== undefined ? { topicId: body.topic_id } : {}),
        ...(body.scheduled_at !== undefined
          ? { scheduledAt: new Date(body.scheduled_at) }
          : {}),
      },
      select: BROADCAST_SELECT,
    });

    return c.json(presentBroadcast(updated), 200);
  });

  // Delete
  app.delete("/broadcasts/:id", async (c) => {
    await deleteCampaign(c.req.param("id"), c.var.team.id);
    return c.json({ object: "broadcast", id: c.req.param("id") }, 200);
  });

  // Send
  app.post("/broadcasts/:id/send", async (c) => {
    const teamId = c.var.team.id;
    const id = c.req.param("id");

    const campaign = await db.campaign.findFirst({
      where: { id, teamId },
      select: { id: true },
    });
    if (!campaign) throw new ResendApiError("not_found", "Broadcast not found");

    const body = await readJsonBody(c).then((raw) =>
      sendBroadcastSchema.safeParse(raw),
    );

    if (body.success && body.data.scheduled_at) {
      await scheduleCampaign({
        campaignId: id,
        teamId,
        scheduledAt: body.data.scheduled_at,
      });
    } else {
      await sendCampaign(id);
    }

    return c.json({ object: "broadcast", id }, 200);
  });

  // Cancel
  app.post("/broadcasts/:id/cancel", async (c) => {
    const teamId = c.var.team.id;
    const id = c.req.param("id");
    const campaign = await db.campaign.findFirst({
      where: { id, teamId },
      select: { id: true },
    });
    if (!campaign) throw new ResendApiError("not_found", "Broadcast not found");

    await pauseCampaign({ campaignId: id, teamId });
    return c.json({ object: "broadcast", id }, 200);
  });

  // Duplicate
  app.post("/broadcasts/:id/duplicate", async (c) => {
    const teamId = c.var.team.id;
    const id = c.req.param("id");
    const source = await db.campaign.findFirst({
      where: { id, teamId },
    });
    if (!source) throw new ResendApiError("not_found", "Broadcast not found");

    const copy = await db.campaign.create({
      data: {
        teamId,
        name: `${source.name} (copy)`,
        from: source.from,
        subject: source.subject,
        previewText: source.previewText,
        html: source.html,
        content: source.content,
        contactBookId: source.contactBookId,
        replyTo: source.replyTo,
        cc: source.cc,
        bcc: source.bcc,
        topicId: source.topicId,
        domainId: source.domainId,
        isApi: true,
        batchSize: source.batchSize,
        batchWindowMinutes: source.batchWindowMinutes,
      },
      select: BROADCAST_SELECT,
    });

    return c.json(presentBroadcast(copy), 201);
  });
}
