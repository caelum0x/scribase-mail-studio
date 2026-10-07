/**
 * Resend /templates routes (Wave 2 B2).
 *
 * GET    /templates             – list
 * POST   /templates             – create
 * GET    /templates/:id         – get (id or alias)
 * PATCH  /templates/:id         – update
 * DELETE /templates/:id         – delete
 * POST   /templates/:id/publish – publish (creates a TemplateVersion)
 * POST   /templates/:id/duplicate – duplicate
 * GET    /templates/:id/versions   – list versions
 */
import { z } from "zod";
import { TemplateService } from "~/server/service/template-service";
import { readJsonBody, type ResendApp } from "./app";

const variableSchema = z.object({
  key: z.string(),
  type: z.enum(["string", "number"]),
  fallback_value: z.union([z.string(), z.number()]).nullish(),
});

const createTemplateSchema = z.object({
  name: z.string().min(1),
  subject: z.string().min(1),
  html: z.string().optional(),
  content: z.string().optional(),
  alias: z.string().optional(),
  variables: z.array(variableSchema).optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  html: z.string().optional(),
  content: z.string().optional(),
  alias: z.string().optional(),
  variables: z.array(variableSchema).optional(),
});

function presentTemplate(
  template: {
    id: string;
    name: string;
    subject: string;
    html: string | null;
    content: string | null;
    alias: string | null;
    variables: unknown;
    publishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  extra?: { version_count?: number },
) {
  return {
    object: "template" as const,
    id: template.id,
    name: template.name,
    subject: template.subject,
    alias: template.alias,
    variables: template.variables ?? [],
    published_at: template.publishedAt?.toISOString() ?? null,
    version_count: extra?.version_count ?? 0,
    created_at: template.createdAt.toISOString(),
    updated_at: template.updatedAt.toISOString(),
  };
}

function presentVersion(v: {
  id: string;
  templateId: string;
  version: number;
  subject: string;
  variables: unknown;
  publishedAt: Date | null;
  createdAt: Date;
}) {
  return {
    object: "template_version" as const,
    id: v.id,
    template_id: v.templateId,
    version: v.version,
    subject: v.subject,
    variables: v.variables ?? [],
    published_at: v.publishedAt?.toISOString() ?? null,
    created_at: v.createdAt.toISOString(),
  };
}

export function registerTemplateRoutes(app: ResendApp): void {
  app.get("/templates", async (c) => {
    const templates = await TemplateService.list(c.var.team.id);
    return c.json(
      {
        object: "list",
        data: templates.map((t) =>
          presentTemplate(t, { version_count: t._count.versions }),
        ),
      },
      200,
    );
  });

  app.post("/templates", async (c) => {
    const body = createTemplateSchema.parse(await readJsonBody(c));
    const template = await TemplateService.create(c.var.team.id, body);
    return c.json(presentTemplate(template), 201);
  });

  app.get("/templates/:id", async (c) => {
    const template = await TemplateService.get(c.var.team.id, c.req.param("id"));
    return c.json(
      presentTemplate(template, { version_count: template.versions.length }),
      200,
    );
  });

  app.patch("/templates/:id", async (c) => {
    const body = updateTemplateSchema.parse(await readJsonBody(c));
    const template = await TemplateService.update(
      c.var.team.id,
      c.req.param("id"),
      body,
    );
    return c.json(presentTemplate(template), 200);
  });

  app.delete("/templates/:id", async (c) => {
    await TemplateService.delete(c.var.team.id, c.req.param("id"));
    return c.json({ object: "template", id: c.req.param("id") }, 200);
  });

  app.post("/templates/:id/publish", async (c) => {
    const version = await TemplateService.publish(
      c.var.team.id,
      c.req.param("id"),
    );
    return c.json(presentVersion(version), 201);
  });

  app.post("/templates/:id/duplicate", async (c) => {
    const template = await TemplateService.duplicate(
      c.var.team.id,
      c.req.param("id"),
    );
    return c.json(presentTemplate(template), 201);
  });

  app.get("/templates/:id/versions", async (c) => {
    const template = await TemplateService.get(c.var.team.id, c.req.param("id"));
    return c.json(
      {
        object: "list",
        data: template.versions.map(presentVersion),
      },
      200,
    );
  });
}
