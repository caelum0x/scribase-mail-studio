/**
 * Resend /audiences routes — deprecated alias for /segments (Wave 2 B1).
 *
 * Resend still accepts /audiences for backwards compatibility; it maps
 * one-to-one onto /segments.  We duplicate the minimal route registrations
 * rather than proxying so there's no HTTP round-trip.
 */
import { z } from "zod";
import { SegmentService } from "~/server/service/segment-service";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";

const createAudienceSchema = z.object({ name: z.string().min(1) });
const contactsSchema = z.object({ contact_ids: z.array(z.string()).min(1) });

function presentAudience(seg: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  _count?: { contacts: number };
}) {
  return {
    object: "audience" as const,
    id: seg.id,
    name: seg.name,
    contact_count: seg._count?.contacts ?? 0,
    created_at: seg.createdAt.toISOString(),
    updated_at: seg.updatedAt.toISOString(),
  };
}

function presentContact(contact: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  subscribed: boolean;
  createdAt: Date;
}) {
  return {
    id: contact.id,
    email: contact.email,
    first_name: contact.firstName,
    last_name: contact.lastName,
    unsubscribed: !contact.subscribed,
    created_at: contact.createdAt.toISOString(),
  };
}

export function registerAudienceRoutes(app: ResendApp): void {
  app.get("/audiences", async (c) => {
    const list = await SegmentService.list(c.var.team.id);
    return c.json({ object: "list", data: list.map(presentAudience) }, 200);
  });

  app.post("/audiences", async (c) => {
    const body = createAudienceSchema.parse(await readJsonBody(c));
    const seg = await SegmentService.create(c.var.team.id, body.name);
    return c.json(presentAudience({ ...seg, _count: { contacts: 0 } }), 201);
  });

  app.get("/audiences/:id", async (c) => {
    const seg = await SegmentService.get(c.var.team.id, c.req.param("id"));
    return c.json(presentAudience(seg), 200);
  });

  app.patch("/audiences/:id", async (c) => {
    const body = createAudienceSchema.parse(await readJsonBody(c));
    const seg = await SegmentService.update(
      c.var.team.id,
      c.req.param("id"),
      body.name,
    );
    return c.json(presentAudience(seg), 200);
  });

  app.delete("/audiences/:id", async (c) => {
    await SegmentService.delete(c.var.team.id, c.req.param("id"));
    return c.json({ object: "audience", id: c.req.param("id") }, 200);
  });

  app.get("/audiences/:id/contacts", async (c) => {
    const contacts = await SegmentService.listContacts(
      c.var.team.id,
      c.req.param("id"),
    );
    return c.json({ object: "list", data: contacts.map(presentContact) }, 200);
  });

  app.post("/audiences/:id/contacts", async (c) => {
    const body = contactsSchema.parse(await readJsonBody(c));
    const added = await SegmentService.addContacts(
      c.var.team.id,
      c.req.param("id"),
      body.contact_ids,
    );
    return c.json(
      { object: "list", data: added.map((contact) => ({ id: contact.id })) },
      200,
    );
  });

  app.delete("/audiences/:id/contacts", async (c) => {
    const body = contactsSchema.parse(await readJsonBody(c));
    await SegmentService.removeContacts(
      c.var.team.id,
      c.req.param("id"),
      body.contact_ids,
    );
    return c.json(
      { object: "list", data: body.contact_ids.map((id) => ({ id })) },
      200,
    );
  });
}
