/**
 * Resend /segments routes (Wave 2 B1).
 *
 * GET    /segments             – list
 * POST   /segments             – create
 * GET    /segments/:id         – get
 * PATCH  /segments/:id         – update name
 * DELETE /segments/:id         – delete
 * GET    /segments/:id/contacts         – list contacts
 * POST   /segments/:id/contacts         – add contacts
 * DELETE /segments/:id/contacts         – remove contacts
 */
import { z } from "zod";
import { SegmentService } from "~/server/service/segment-service";
import { readJsonBody, type ResendApp } from "./app";

const createSegmentSchema = z.object({
  name: z.string().min(1),
});

const addRemoveContactsSchema = z.object({
  contact_ids: z.array(z.string()).min(1),
});

function presentSegment(seg: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  _count?: { contacts: number };
}) {
  return {
    object: "segment" as const,
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

export function registerSegmentRoutes(app: ResendApp): void {
  app.get("/segments", async (c) => {
    const list = await SegmentService.list(c.var.team.id);
    return c.json({ object: "list", data: list.map(presentSegment) }, 200);
  });

  app.post("/segments", async (c) => {
    const body = createSegmentSchema.parse(await readJsonBody(c));
    const seg = await SegmentService.create(c.var.team.id, body.name);
    return c.json(presentSegment({ ...seg, _count: { contacts: 0 } }), 201);
  });

  app.get("/segments/:id", async (c) => {
    const seg = await SegmentService.get(c.var.team.id, c.req.param("id"));
    return c.json(presentSegment(seg), 200);
  });

  app.patch("/segments/:id", async (c) => {
    const body = createSegmentSchema.parse(await readJsonBody(c));
    const seg = await SegmentService.update(
      c.var.team.id,
      c.req.param("id"),
      body.name,
    );
    return c.json(presentSegment(seg), 200);
  });

  app.delete("/segments/:id", async (c) => {
    await SegmentService.delete(c.var.team.id, c.req.param("id"));
    return c.json({ object: "segment", id: c.req.param("id") }, 200);
  });

  app.get("/segments/:id/contacts", async (c) => {
    const contacts = await SegmentService.listContacts(
      c.var.team.id,
      c.req.param("id"),
    );
    return c.json(
      { object: "list", data: contacts.map(presentContact) },
      200,
    );
  });

  app.post("/segments/:id/contacts", async (c) => {
    const body = addRemoveContactsSchema.parse(await readJsonBody(c));
    const added = await SegmentService.addContacts(
      c.var.team.id,
      c.req.param("id"),
      body.contact_ids,
    );
    return c.json(
      { object: "list", data: added.map((c2) => ({ id: c2.id })) },
      200,
    );
  });

  app.delete("/segments/:id/contacts", async (c) => {
    const body = addRemoveContactsSchema.parse(await readJsonBody(c));
    await SegmentService.removeContacts(
      c.var.team.id,
      c.req.param("id"),
      body.contact_ids,
    );
    return c.json({ object: "list", data: body.contact_ids.map((id) => ({ id })) }, 200);
  });
}
