/**
 * Resend /topics routes (Wave 2 B1).
 *
 * GET    /topics           – list
 * POST   /topics           – create
 * GET    /topics/:id       – get
 * PATCH  /topics/:id       – update
 * DELETE /topics/:id       – delete
 * GET    /contacts/:id/topics/:tid         – get contact subscription
 * PUT    /contacts/:id/topics/:tid         – set contact subscription
 */
import { z } from "zod";
import { TopicSubscription, TopicVisibility } from "@prisma/client";
import { TopicService } from "~/server/service/topic-service";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";

const createTopicSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  default_subscription: z.nativeEnum(TopicSubscription).optional(),
  visibility: z.nativeEnum(TopicVisibility).optional(),
});

const updateTopicSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  default_subscription: z.nativeEnum(TopicSubscription).optional(),
  visibility: z.nativeEnum(TopicVisibility).optional(),
});

const setSubscriptionSchema = z.object({
  subscription: z.nativeEnum(TopicSubscription),
});

function presentTopic(topic: {
  id: string;
  name: string;
  description: string | null;
  defaultSubscription: TopicSubscription;
  visibility: TopicVisibility;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    object: "topic" as const,
    id: topic.id,
    name: topic.name,
    description: topic.description,
    default_subscription: topic.defaultSubscription,
    visibility: topic.visibility,
    created_at: topic.createdAt.toISOString(),
    updated_at: topic.updatedAt.toISOString(),
  };
}

export function registerTopicRoutes(app: ResendApp): void {
  // List
  app.get("/topics", async (c) => {
    const teamId = c.var.team.id;
    const topics = await TopicService.list(teamId);
    return c.json({ object: "list", data: topics.map(presentTopic) }, 200);
  });

  // Create
  app.post("/topics", async (c) => {
    const teamId = c.var.team.id;
    const body = createTopicSchema.parse(await readJsonBody(c));
    const topic = await TopicService.create(teamId, {
      name: body.name,
      description: body.description,
      defaultSubscription: body.default_subscription,
      visibility: body.visibility,
    });
    return c.json(presentTopic(topic), 201);
  });

  // Get
  app.get("/topics/:id", async (c) => {
    const topic = await TopicService.get(c.var.team.id, c.req.param("id"));
    return c.json(presentTopic(topic), 200);
  });

  // Update
  app.patch("/topics/:id", async (c) => {
    const teamId = c.var.team.id;
    const body = updateTopicSchema.parse(await readJsonBody(c));
    const topic = await TopicService.update(teamId, c.req.param("id"), {
      name: body.name,
      description: body.description,
      defaultSubscription: body.default_subscription,
      visibility: body.visibility,
    });
    return c.json(presentTopic(topic), 200);
  });

  // Delete
  app.delete("/topics/:id", async (c) => {
    await TopicService.delete(c.var.team.id, c.req.param("id"));
    return c.json({ object: "topic", id: c.req.param("id") }, 200);
  });

  // Get contact subscription for a topic
  app.get("/contacts/:contactId/topics/:topicId", async (c) => {
    const teamId = c.var.team.id;
    const { contactId, topicId } = c.req.param();
    const row = await TopicService.getContactSubscription(teamId, contactId, topicId);
    const topic = await TopicService.get(teamId, topicId);
    return c.json(
      {
        object: "contact_topic",
        contact_id: contactId,
        topic_id: topicId,
        subscription: row?.subscription ?? topic.defaultSubscription,
        is_explicit: row !== null,
      },
      200,
    );
  });

  // Set contact subscription for a topic
  app.put("/contacts/:contactId/topics/:topicId", async (c) => {
    const teamId = c.var.team.id;
    const { contactId, topicId } = c.req.param();
    const body = setSubscriptionSchema.parse(await readJsonBody(c));
    await TopicService.setContactSubscription(
      teamId,
      contactId,
      topicId,
      body.subscription,
    );
    return c.json(
      {
        object: "contact_topic",
        contact_id: contactId,
        topic_id: topicId,
        subscription: body.subscription,
      },
      200,
    );
  });
}
