/**
 * Resend /contact-properties routes (Wave 2 B1).
 *
 * GET    /contact-properties         – list
 * POST   /contact-properties         – create
 * GET    /contact-properties/:id     – get
 * PATCH  /contact-properties/:id     – update
 * DELETE /contact-properties/:id     – delete
 */
import { z } from "zod";
import { ContactPropertyType } from "@prisma/client";
import { db } from "~/server/db";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";
import { UnsendApiError } from "../api-error";

const propertyTypeSchema = z.enum(["string", "number"]).transform((v) =>
  v === "string" ? ContactPropertyType.STRING : ContactPropertyType.NUMBER,
);

const createPropertySchema = z.object({
  key: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
    message: "key must start with a letter or underscore and contain only alphanumerics and underscores",
  }),
  type: propertyTypeSchema,
  fallback_value: z.union([z.string(), z.number()]).nullish(),
});

const updatePropertySchema = z.object({
  key: z.string().min(1).optional(),
  type: propertyTypeSchema.optional(),
  fallback_value: z.union([z.string(), z.number()]).nullish(),
});

function presentProperty(prop: {
  id: string;
  key: string;
  type: ContactPropertyType;
  fallbackValue: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    object: "contact_property" as const,
    id: prop.id,
    key: prop.key,
    type: prop.type === ContactPropertyType.STRING ? "string" : "number",
    fallback_value: prop.fallbackValue ?? null,
    created_at: prop.createdAt.toISOString(),
    updated_at: prop.updatedAt.toISOString(),
  };
}

export function registerContactPropertyRoutes(app: ResendApp): void {
  app.get("/contact-properties", async (c) => {
    const props = await db.contactProperty.findMany({
      where: { teamId: c.var.team.id },
      orderBy: { createdAt: "desc" },
    });
    return c.json({ object: "list", data: props.map(presentProperty) }, 200);
  });

  app.post("/contact-properties", async (c) => {
    const teamId = c.var.team.id;
    const body = createPropertySchema.parse(await readJsonBody(c));

    try {
      const prop = await db.contactProperty.create({
        data: {
          teamId,
          key: body.key,
          type: body.type,
          fallbackValue: body.fallback_value ?? null,
        },
      });
      return c.json(presentProperty(prop), 201);
    } catch {
      throw new ResendApiError(
        "validation_error",
        `Property key \`${body.key}\` already exists`,
      );
    }
  });

  app.get("/contact-properties/:id", async (c) => {
    const prop = await db.contactProperty.findFirst({
      where: { id: c.req.param("id"), teamId: c.var.team.id },
    });
    if (!prop) throw new ResendApiError("not_found", "Contact property not found");
    return c.json(presentProperty(prop), 200);
  });

  app.patch("/contact-properties/:id", async (c) => {
    const teamId = c.var.team.id;
    const id = c.req.param("id");
    const existing = await db.contactProperty.findFirst({
      where: { id, teamId },
    });
    if (!existing) throw new ResendApiError("not_found", "Contact property not found");

    const body = updatePropertySchema.parse(await readJsonBody(c));
    const prop = await db.contactProperty.update({
      where: { id },
      data: {
        ...(body.key !== undefined ? { key: body.key } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.fallback_value !== undefined
          ? { fallbackValue: body.fallback_value ?? null }
          : {}),
      },
    });
    return c.json(presentProperty(prop), 200);
  });

  app.delete("/contact-properties/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await db.contactProperty.findFirst({
      where: { id, teamId: c.var.team.id },
    });
    if (!existing) throw new ResendApiError("not_found", "Contact property not found");
    await db.contactProperty.delete({ where: { id } });
    return c.json({ object: "contact_property", id }, 200);
  });
}
