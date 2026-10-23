/**
 * Topic service — Resend /topics API (Wave 2 B1).
 *
 * Topics represent subscription categories. Each contact may have an explicit
 * preference per topic (ContactTopic); absent rows fall back to the topic's
 * `defaultSubscription`.  Marketing sends that specify a `topicId` skip any
 * recipient who has opted out.
 */
import { TopicSubscription, TopicVisibility } from "@prisma/client";
import { db } from "../db";
import { UnsendApiError } from "../public-api/api-error";
import { verifyUnsubscribeLink } from "./campaign-service";

export type PublicTopicPreference = {
  id: string;
  name: string;
  description: string | null;
  subscribed: boolean;
};

export type CreateTopicInput = {
  name: string;
  description?: string;
  defaultSubscription?: TopicSubscription;
  visibility?: TopicVisibility;
};

export type UpdateTopicInput = Partial<CreateTopicInput>;

export class TopicService {
  static async create(teamId: number, input: CreateTopicInput) {
    return db.topic.create({
      data: {
        teamId,
        name: input.name,
        description: input.description ?? null,
        defaultSubscription: input.defaultSubscription ?? TopicSubscription.OPT_IN,
        visibility: input.visibility ?? TopicVisibility.PRIVATE,
      },
    });
  }

  static async get(teamId: number, topicId: string) {
    const topic = await db.topic.findFirst({
      where: { id: topicId, teamId },
    });
    if (!topic) {
      throw new UnsendApiError({ code: "NOT_FOUND", message: "Topic not found" });
    }
    return topic;
  }

  static async list(teamId: number) {
    return db.topic.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async update(teamId: number, topicId: string, input: UpdateTopicInput) {
    await TopicService.get(teamId, topicId); // throws if missing
    return db.topic.update({
      where: { id: topicId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.defaultSubscription !== undefined
          ? { defaultSubscription: input.defaultSubscription }
          : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      },
    });
  }

  static async delete(teamId: number, topicId: string) {
    await TopicService.get(teamId, topicId);
    await db.topic.delete({ where: { id: topicId } });
  }

  /**
   * Get or update a contact's subscription preference for a topic.
   * Upserts a ContactTopic row; deleteing the row (when reset) is not needed
   * because the default is stored on the topic itself.
   */
  static async getContactSubscription(
    teamId: number,
    contactId: string,
    topicId: string,
  ) {
    await TopicService.get(teamId, topicId);
    const row = await db.contactTopic.findUnique({
      where: { contactId_topicId: { contactId, topicId } },
    });
    return row;
  }

  static async setContactSubscription(
    teamId: number,
    contactId: string,
    topicId: string,
    subscription: TopicSubscription,
  ) {
    await TopicService.get(teamId, topicId);
    return db.contactTopic.upsert({
      where: { contactId_topicId: { contactId, topicId } },
      create: { contactId, topicId, subscription },
      update: { subscription },
    });
  }

  /**
   * Returns true if the given email address has opted out of the topic, taking
   * the ContactTopic row into account (or the topic default when no row exists).
   */
  static async isOptedOut(
    teamId: number,
    topicId: string,
    email: string,
  ): Promise<boolean> {
    const topic = await db.topic.findFirst({
      where: { id: topicId, teamId },
      select: { defaultSubscription: true },
    });
    if (!topic) return false;

    // Look up the contact's preference across all books owned by this team.
    const row = await db.contactTopic.findFirst({
      where: {
        topicId,
        contact: {
          email: email.toLowerCase(),
          contactBook: { teamId },
        },
      },
    });

    const subscription = row?.subscription ?? topic.defaultSubscription;
    return subscription === TopicSubscription.OPT_OUT;
  }

  // ── Public preference center (unsubscribe link reuse) ───────────────────

  /**
   * Resolves the team + contact behind a signed unsubscribe link, re-using
   * the same HMAC the one-click/unsubscribe links already carry so the
   * preference center never needs its own auth scheme.
   */
  private static async resolveContactFromLink(id: string, hash: string) {
    const { contactId } = verifyUnsubscribeLink(id, hash);
    const contact = await db.contact.findUnique({
      where: { id: contactId },
      include: { contactBook: { select: { teamId: true } } },
    });
    if (!contact) {
      throw new UnsendApiError({ code: "NOT_FOUND", message: "Contact not found" });
    }
    return contact;
  }

  /**
   * Public, granular alternative to the all-or-nothing unsubscribe link:
   * returns every PUBLIC topic for the contact's team with their current
   * subscription state (defaulting to the topic's `defaultSubscription`).
   */
  static async getPublicPreferencesFromLink(
    id: string,
    hash: string,
  ): Promise<{ email: string; topics: PublicTopicPreference[] }> {
    const contact = await TopicService.resolveContactFromLink(id, hash);
    const teamId = contact.contactBook.teamId;

    const topics = await db.topic.findMany({
      where: { teamId, visibility: TopicVisibility.PUBLIC },
      orderBy: { name: "asc" },
    });

    if (topics.length === 0) {
      return { email: contact.email, topics: [] };
    }

    const prefs = await db.contactTopic.findMany({
      where: { contactId: contact.id, topicId: { in: topics.map((t) => t.id) } },
    });
    const prefMap = new Map(prefs.map((p) => [p.topicId, p.subscription]));

    return {
      email: contact.email,
      topics: topics.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        subscribed:
          (prefMap.get(t.id) ?? t.defaultSubscription) ===
          TopicSubscription.OPT_IN,
      })),
    };
  }

  /**
   * Saves per-topic opt in/out choices from the public preference center.
   * Silently ignores any topicId that doesn't belong to the contact's team
   * or isn't PUBLIC, so a tampered request can't flip private topics.
   */
  static async updatePublicPreferencesFromLink(
    id: string,
    hash: string,
    updates: Array<{ topicId: string; subscribed: boolean }>,
  ): Promise<{ success: true }> {
    const contact = await TopicService.resolveContactFromLink(id, hash);
    const teamId = contact.contactBook.teamId;

    const validTopics = await db.topic.findMany({
      where: {
        id: { in: updates.map((u) => u.topicId) },
        teamId,
        visibility: TopicVisibility.PUBLIC,
      },
      select: { id: true },
    });
    const validIds = new Set(validTopics.map((t) => t.id));

    await Promise.all(
      updates
        .filter((u) => validIds.has(u.topicId))
        .map((u) =>
          db.contactTopic.upsert({
            where: {
              contactId_topicId: { contactId: contact.id, topicId: u.topicId },
            },
            create: {
              contactId: contact.id,
              topicId: u.topicId,
              subscription: u.subscribed
                ? TopicSubscription.OPT_IN
                : TopicSubscription.OPT_OUT,
            },
            update: {
              subscription: u.subscribed
                ? TopicSubscription.OPT_IN
                : TopicSubscription.OPT_OUT,
            },
          }),
        ),
    );

    return { success: true };
  }
}
