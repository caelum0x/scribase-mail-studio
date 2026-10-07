import { z } from "zod";
import type { ApiPermission } from "@prisma/client";
import { addApiKey, deleteApiKey } from "~/server/service/api-service";
import { db } from "~/server/db";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";

// ---------------------------------------------------------------------------
// Resend API key permission mapping
// ---------------------------------------------------------------------------

const RESEND_TO_INTERNAL_PERMISSION: Record<string, ApiPermission> = {
  full_access: "FULL",
  sending_access: "SENDING",
};

const INTERNAL_TO_RESEND_PERMISSION: Record<ApiPermission, string> = {
  FULL: "full_access",
  SENDING: "sending_access",
};

function toResendPermission(p: ApiPermission): string {
  return INTERNAL_TO_RESEND_PERMISSION[p] ?? "full_access";
}

function toInternalPermission(p: string): ApiPermission {
  const internal = RESEND_TO_INTERNAL_PERMISSION[p];
  if (!internal) {
    throw new ResendApiError(
      "validation_error",
      `Invalid permission '${p}'. Use 'full_access' or 'sending_access'.`,
    );
  }
  return internal;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerApiKeyRoutes(app: ResendApp): void {
  // POST /api-keys — create an API key. Token is returned only once.
  app.post("/api-keys", async (c) => {
    const team = c.var.team;
    const body = z
      .object({
        name: z.string().min(1),
        permission: z.string().optional(),
        domain_id: z.string().optional(),
      })
      .strict()
      .parse(await readJsonBody(c));

    const permission = toInternalPermission(body.permission ?? "full_access");

    let domainId: number | undefined;
    if (body.domain_id !== undefined) {
      domainId = Number(body.domain_id);
      if (!Number.isInteger(domainId) || domainId <= 0) {
        throw new ResendApiError(
          "validation_error",
          "Invalid `domain_id`.",
        );
      }
      // Verify the domain belongs to this team.
      const domain = await db.domain.findFirst({
        where: { id: domainId, teamId: team.id },
        select: { id: true },
      });
      if (!domain) {
        throw new ResendApiError("not_found", "Domain not found");
      }
    }

    let token: string;
    try {
      token = await addApiKey({
        name: body.name,
        permission,
        teamId: team.id,
        domainId,
      });
    } catch (err) {
      if (err instanceof Error && err.message === "DOMAIN_NOT_FOUND") {
        throw new ResendApiError("not_found", "Domain not found");
      }
      throw new ResendApiError(
        "application_error",
        err instanceof Error ? err.message : "Failed to create API key.",
      );
    }

    // Retrieve the newly-created key to get its numeric id.
    // addApiKey returns the token string; we need to find the row by clientId.
    const parts = token.split("_");
    const clientId = parts[1];
    const keyRow = clientId
      ? await db.apiKey.findUnique({
          where: { clientId },
          select: { id: true, name: true, permission: true, domainId: true, createdAt: true },
        })
      : null;

    return c.json(
      {
        id: String(keyRow?.id ?? ""),
        token,
        name: keyRow?.name ?? body.name,
        permission: toResendPermission(keyRow?.permission ?? permission),
        ...(keyRow?.domainId !== undefined && keyRow.domainId !== null
          ? { domain_id: String(keyRow.domainId) }
          : {}),
        created_at: (keyRow?.createdAt ?? new Date()).toISOString(),
      },
      201,
    );
  });

  // GET /api-keys — list all API keys (tokens are not included in the list).
  app.get("/api-keys", async (c) => {
    const team = c.var.team;
    const keys = await db.apiKey.findMany({
      where: { teamId: team.id },
      select: {
        id: true,
        name: true,
        permission: true,
        domainId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return c.json(
      {
        object: "list",
        data: keys.map((key) => ({
          id: String(key.id),
          name: key.name,
          permission: toResendPermission(key.permission),
          ...(key.domainId !== null
            ? { domain_id: String(key.domainId) }
            : {}),
          created_at: key.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  // DELETE /api-keys/:id — delete an API key.
  app.delete("/api-keys/:id", async (c) => {
    const team = c.var.team;
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ResendApiError("not_found", "API key not found");
    }

    // Verify the key belongs to this team before deleting.
    const existing = await db.apiKey.findFirst({
      where: { id, teamId: team.id },
      select: { id: true },
    });
    if (!existing) {
      throw new ResendApiError("not_found", "API key not found");
    }

    await deleteApiKey(id);

    return c.json({ object: "api_key", id: String(id), deleted: true }, 200);
  });
}
