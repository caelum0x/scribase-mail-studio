import { Prisma } from "@prisma/client";
/**
 * Template service — Resend /templates API (Wave 2 B2).
 *
 * Provides CRUD, publish (creates a TemplateVersion snapshot), duplicate,
 * alias management and variable resolution.
 */
import { db } from "../db";
import { UnsendApiError } from "../public-api/api-error";

export type TemplateVariable = {
  key: string;
  type: "string" | "number";
  fallback_value?: string | number | null;
};

export type CreateTemplateInput = {
  name: string;
  subject: string;
  html?: string;
  content?: string;
  alias?: string;
  variables?: TemplateVariable[];
};

export type UpdateTemplateInput = Partial<CreateTemplateInput>;

export class TemplateService {
  // ── CRUD ────────────────────────────────────────────────────────────────

  static async create(teamId: number, input: CreateTemplateInput) {
    if (input.alias) {
      await TemplateService.assertAliasAvailable(teamId, input.alias);
    }
    return db.template.create({
      data: {
        teamId,
        name: input.name,
        subject: input.subject,
        html: input.html ?? null,
        content: input.content ?? null,
        alias: input.alias ?? null,
        variables: input.variables ? JSON.parse(JSON.stringify(input.variables)) : null,
      },
    });
  }

  static async get(teamId: number, idOrAlias: string) {
    const template = await db.template.findFirst({
      where: {
        teamId,
        OR: [{ id: idOrAlias }, { alias: idOrAlias }],
      },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!template) {
      throw new UnsendApiError({ code: "NOT_FOUND", message: "Template not found" });
    }
    return template;
  }

  static async list(teamId: number) {
    return db.template.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { versions: true } } },
    });
  }

  static async update(teamId: number, idOrAlias: string, input: UpdateTemplateInput) {
    const template = await TemplateService.get(teamId, idOrAlias);

    if (input.alias && input.alias !== template.alias) {
      await TemplateService.assertAliasAvailable(teamId, input.alias);
    }

    return db.template.update({
      where: { id: template.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.html !== undefined ? { html: input.html } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.alias !== undefined ? { alias: input.alias } : {}),
        ...(input.variables !== undefined
          ? { variables: JSON.parse(JSON.stringify(input.variables)) }
          : {}),
      },
    });
  }

  static async delete(teamId: number, idOrAlias: string) {
    const template = await TemplateService.get(teamId, idOrAlias);
    await db.template.delete({ where: { id: template.id } });
  }

  // ── Publish / versions ──────────────────────────────────────────────────

  /**
   * Publish creates an immutable TemplateVersion snapshot and sets
   * `publishedAt` on the template.  Returns the new version.
   */
  static async publish(teamId: number, idOrAlias: string) {
    const template = await TemplateService.get(teamId, idOrAlias);

    const lastVersion = await db.templateVersion.findFirst({
      where: { templateId: template.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    const nextVersion = (lastVersion?.version ?? 0) + 1;
    const now = new Date();

    const [version] = await Promise.all([
      db.templateVersion.create({
        data: {
          templateId: template.id,
          version: nextVersion,
          subject: template.subject,
          html: template.html,
          content: template.content,
          variables: template.variables ?? Prisma.JsonNull,
          publishedAt: now,
        },
      }),
      db.template.update({
        where: { id: template.id },
        data: { publishedAt: now },
      }),
    ]);

    return version;
  }

  // ── Duplicate ───────────────────────────────────────────────────────────

  static async duplicate(teamId: number, idOrAlias: string) {
    const source = await TemplateService.get(teamId, idOrAlias);
    return db.template.create({
      data: {
        teamId,
        name: `${source.name} (copy)`,
        subject: source.subject,
        html: source.html,
        content: source.content,
        variables: source.variables ?? undefined,
        alias: null,
      },
    });
  }

  // ── Variable resolution ─────────────────────────────────────────────────

  /**
   * Apply Resend `{{{VAR}}}` triple-moustache syntax AND `{{VAR}}` double-moustache
   * syntax to the subject / html body, substituting caller-provided values.
   * Falls back to the variable definition's `fallback_value`.
   */
  static applyVariables(
    source: string,
    provided: Record<string, string | number>,
    definitions: TemplateVariable[],
  ): string {
    const fallbacks: Record<string, string | number> = {};
    for (const def of definitions) {
      if (def.fallback_value !== undefined && def.fallback_value !== null) {
        fallbacks[def.key] = def.fallback_value;
      }
    }

    // Triple-moustache first (exact match), then double-moustache.
    return source.replace(
      /\{{{([^}]+)}}}/g,
      (_, key: string) =>
        String(
          provided[key.trim()] ?? fallbacks[key.trim()] ?? `{{{${key}}}}`,
        ),
    ).replace(
      /{{([^}]+)}}/g,
      (_, key: string) =>
        String(provided[key.trim()] ?? fallbacks[key.trim()] ?? `{{${key}}}`),
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private static async assertAliasAvailable(teamId: number, alias: string) {
    const existing = await db.template.findFirst({
      where: { teamId, alias },
      select: { id: true },
    });
    if (existing) {
      throw new UnsendApiError({
        code: "NOT_UNIQUE",
        message: `Template alias \`${alias}\` is already in use`,
      });
    }
  }
}
