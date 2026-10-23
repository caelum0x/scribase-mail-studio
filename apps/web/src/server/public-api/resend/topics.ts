/**
 * Resend /topics routes (Wave 2 B1).
 *
 * GET    /topics           – list
 * POST   /topics           – create
 * GET    /topics/:id       – get
 * PATCH  /topics/:id       – update
 * DELETE /topics/:id       – delete
 * GET    /contacts/:id/topics              – list a contact's topics (resend SDK)
 * PATCH  /contacts/:id/topics              – set a contact's topic subscriptions
 * GET    /contacts/:id/topics/:tid         – get contact subscription
 * PUT    /contacts/:id/topics/:tid         – set contact subscription
 */
import { z } from "zod";
import { TopicSubscription, TopicVisibility } from "@prisma/client";
import { db } from "~/server/db";
import { TopicService } from "~/server/service/topic-service";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";
import { mapList, paginate, parseCursorParams } from "./pagination";

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

/** Body of PATCH /contacts/:id/topics. The Resend SDK sends the array itself. */
const updateContactTopicsSchema = z.array(
  z.object({
    id: z.string().min(1),
    subscription: z.string().min(1),
  }),
);

function toResendSubscription(value: TopicSubscription): "opt_in" | "opt_out" {
  return value === TopicSubscription.OPT_OUT ? "opt_out" : "opt_in";
}

function fromResendSubscription(value: string): TopicSubscription {
  switch (value) {
    case "opt_in":
    case "OPT_IN":
      return TopicSubscription.OPT_IN;
    case "opt_out":
    case "OPT_OUT":
      return TopicSubscription.OPT_OUT;
    default:
      throw new ResendApiError(
        "validation_error",
        "Invalid `subscription`. Use `opt_in` or `opt_out`.",
      );
  }
}

/**
 * Contact addressed the way `resend.contacts.topics` does: id, or email in
 * the team's default book. Does not create a book.
 */
async function findDefaultBookContact(teamId: number, idOrEmail: string) {
  const book = await db.contactBook.findFirst({
    where: { teamId, isDefault: true },
    select: { id: true },
  });
  if (!book) return null;

  const byId = await db.contact.findFirst({
    where: { id: idOrEmail, contactBookId: book.id },
  });
  if (byId) return byId;

  if (!idOrEmail.includes("@")) return null;
  return db.contact.findFirst({
    where: { email: idOrEmail.toLowerCase(), contactBookId: book.id },
  });
}

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

  // List a contact's topics. `resend.contacts.topics.list` calls this.
  // Subscription is the explicit ContactTopic row, or the topic default.
  app.get("/contacts/:id/topics", async (c) => {
    const teamId = c.var.team.id;
    const contact = await findDefaultBookContact(teamId, c.req.param("id"));
    if (!contact) {
      throw new ResendApiError("not_found", "Contact not found");
    }

    const params = parseCursorParams(c.req.query());
    const list = await paginate(params, {
      resolveCursor: (id) =>
        db.topic.findFirst({
          where: { id, teamId },
          select: { id: true, createdAt: true },
        }),
      fetch: ({ cursor, orderBy, take }) =>
        db.topic.findMany({
          where: cursor ? { AND: [{ teamId }, cursor] } : { teamId },
          orderBy,
          take,
        }),
    });

    const prefs =
      list.data.length === 0
        ? []
        : await db.contactTopic.findMany({
            where: {
              contactId: contact.id,
              topicId: { in: list.data.map((topic) => topic.id) },
            },
          });
    const prefByTopic = new Map(prefs.map((row) => [row.topicId, row]));

    return c.json(
      mapList(list, (topic) => ({
        id: topic.id,
        name: topic.name,
        description: topic.description,
        subscription: toResendSubscription(
          prefByTopic.get(topic.id)?.subscription ?? topic.defaultSubscription,
        ),
      })),
      200,
    );
  });

  // Set many topic subscriptions. `resend.contacts.topics.update` PATCHes
  // the topics array. Unknown topics fail the request before any write.
  app.patch("/contacts/:id/topics", async (c) => {
    const teamId = c.var.team.id;
    const contact = await findDefaultBookContact(teamId, c.req.param("id"));
    if (!contact) {
      throw new ResendApiError("not_found", "Contact not found");
    }

    const items = updateContactTopicsSchema.parse(await readJsonBody(c));
    if (items.length === 0) {
      throw new ResendApiError(
        "missing_required_field",
        "Missing `topics` field.",
      );
    }

    const updates = items.map((item) => ({
      id: item.id,
      subscription: fromResendSubscription(item.subscription),
    }));
    for (const item of updates) {
      await TopicService.get(teamId, item.id);
    }
    for (const item of updates) {
      await TopicService.setContactSubscription(
        teamId,
        contact.id,
        item.id,
        item.subscription,
      );
    }

    return c.json({ object: "contact_topics", id: contact.id }, 200);
  });

  // Get contact subscription for a topic
  app.get("/contacts/:contactId/topics/:topicId", async (c) => {
    const teamId = c.var.team.id;
    const { contactId, topicId } = c.req.param();
    const row = await TopicService.getContactSubscription(
      teamId,
      contactId,
      topicId,
    );
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
