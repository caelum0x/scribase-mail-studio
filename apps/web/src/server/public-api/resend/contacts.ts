/**
 * Resend /contacts routes (Wave 2 B1).
 *
 * Resend uses a flat, team-level contacts model.  We map it onto the existing
 * ContactBook/Contact structure using the team's default ContactBook (isDefault=true).
 * A default book is created on first use if it does not yet exist.
 *
 * GET    /contacts             – list
 * POST   /contacts             – create / upsert
 * GET    /contacts/:id         – get by id OR email
 * PATCH  /contacts/:id         – update
 * DELETE /contacts/:id         – delete
 */
import { z } from "zod";
import { db } from "~/server/db";
import {
  addOrUpdateContact,
  deleteContactInContactBook,
  updateContactInContactBook,
} from "~/server/service/contact-service";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";
import { paginate, parseCursorParams } from "./pagination";

// ── Default book ────────────────────────────────────────────────────────────

async function getOrCreateDefaultBook(teamId: number): Promise<string> {
  const existing = await db.contactBook.findFirst({
    where: { teamId, isDefault: true },
    select: { id: true },
  });
  if (existing) return existing.id;

  const book = await db.contactBook.create({
    data: {
      teamId,
      name: "Default",
      isDefault: true,
      properties: {},
      variables: [],
      doubleOptInEnabled: false,
    },
  });
  return book.id;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const createContactSchema = z.object({
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  unsubscribed: z.boolean().optional(),
  audience_id: z.string().optional(), // legacy: treated as segment id
});

const updateContactSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  unsubscribed: z.boolean().optional(),
});

// ── Presenter ────────────────────────────────────────────────────────────────

function presentContact(contact: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  subscribed: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    object: "contact" as const,
    id: contact.id,
    email: contact.email,
    first_name: contact.firstName,
    last_name: contact.lastName,
    unsubscribed: !contact.subscribed,
    created_at: contact.createdAt.toISOString(),
    updated_at: contact.updatedAt.toISOString(),
  };
}

// ── Route helpers ─────────────────────────────────────────────────────────────

async function findContact(teamId: number, idOrEmail: string, bookId: string) {
  // Try id first.
  const byId = await db.contact.findFirst({
    where: { id: idOrEmail, contactBookId: bookId },
  });
  if (byId) return byId;

  // Try email if the param looks like one.
  if (idOrEmail.includes("@")) {
    return db.contact.findFirst({
      where: { email: idOrEmail.toLowerCase(), contactBookId: bookId },
    });
  }

  return null;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerContactRoutes(app: ResendApp): void {
  // List
  app.get("/contacts", async (c) => {
    const teamId = c.var.team.id;
    const bookId = await getOrCreateDefaultBook(teamId);
    const params = parseCursorParams(c.req.query());

    const list = await paginate(params, {
      resolveCursor: (id) =>
        db.contact.findFirst({
          where: { id, contactBookId: bookId },
          select: { id: true, createdAt: true },
        }),
      fetch: ({ cursor, orderBy, take }) =>
        db.contact.findMany({
          where: cursor
            ? { AND: [{ contactBookId: bookId }, cursor] }
            : { contactBookId: bookId },
          orderBy,
          take,
        }),
    });

    return c.json(
      {
        object: "list" as const,
        has_more: list.has_more,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: (list.data as any[]).map(presentContact),
      },
      200,
    );
  });

  // Create / upsert
  app.post("/contacts", async (c) => {
    const teamId = c.var.team.id;
    const body = createContactSchema.parse(await readJsonBody(c));
    const bookId = await getOrCreateDefaultBook(teamId);

    const contact = await addOrUpdateContact(
      bookId,
      {
        email: body.email,
        firstName: body.first_name,
        lastName: body.last_name,
        subscribed: body.unsubscribed !== undefined ? !body.unsubscribed : undefined,
      },
      teamId,
    );

    return c.json(presentContact(contact), 200);
  });

  // Get by id or email
  app.get("/contacts/:id", async (c) => {
    const teamId = c.var.team.id;
    const bookId = await getOrCreateDefaultBook(teamId);
    const contact = await findContact(teamId, c.req.param("id"), bookId);
    if (!contact) throw new ResendApiError("not_found", "Contact not found");
    return c.json(presentContact(contact), 200);
  });

  // Update
  app.patch("/contacts/:id", async (c) => {
    const teamId = c.var.team.id;
    const bookId = await getOrCreateDefaultBook(teamId);
    const contact = await findContact(teamId, c.req.param("id"), bookId);
    if (!contact) throw new ResendApiError("not_found", "Contact not found");

    const body = updateContactSchema.parse(await readJsonBody(c));
    const updated = await updateContactInContactBook(
      contact.id,
      bookId,
      {
        firstName: body.first_name,
        lastName: body.last_name,
        subscribed:
          body.unsubscribed !== undefined ? !body.unsubscribed : undefined,
      },
      teamId,
    );

    if (!updated) throw new ResendApiError("not_found", "Contact not found");
    return c.json(presentContact(updated), 200);
  });

  // Delete
  app.delete("/contacts/:id", async (c) => {
    const teamId = c.var.team.id;
    const bookId = await getOrCreateDefaultBook(teamId);
    const contact = await findContact(teamId, c.req.param("id"), bookId);
    if (!contact) throw new ResendApiError("not_found", "Contact not found");

    await deleteContactInContactBook(contact.id, bookId, teamId);
    return c.json({ object: "contact", id: contact.id, deleted: true }, 200);
  });
}
