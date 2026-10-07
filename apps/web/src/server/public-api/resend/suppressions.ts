/**
 * Resend-compatible suppressions API (native Scribase Mail extension —
 * Resend does not expose a fully-documented public suppressions API, but the
 * endpoint is useful for migrations and manual management).
 *
 * GET    /suppressions          — list (with optional ?email, ?reason, ?limit)
 * POST   /suppressions          — add one suppression
 * DELETE /suppressions/:email   — remove one suppression
 *
 * Important: removing a suppression also tries to remove the entry from the
 * OCI tenancy-wide suppression list (handled inside SuppressionService).
 * We never delete the OCI tenancy list entry on a user's behalf for reasons
 * of deliverability; SuppressionService.removeSuppression() handles that
 * distinction.
 */
import { z } from "zod";
import { SuppressionReason } from "@prisma/client";
import { SuppressionService } from "~/server/service/suppression-service";
import { readJsonBody, type ResendApp } from "./app";
import { ResendApiError } from "./errors";

const addSuppressionSchema = z
  .object({
    email: z.string().email({ message: "Invalid email address." }),
    reason: z
      .enum(["manual", "bounce", "complaint"])
      .optional()
      .default("manual"),
  })
  .strict();

function toPrismaReason(reason: string): SuppressionReason {
  switch (reason) {
    case "bounce":
      return SuppressionReason.HARD_BOUNCE;
    case "complaint":
      return SuppressionReason.COMPLAINT;
    default:
      return SuppressionReason.MANUAL;
  }
}

function toReasonLabel(reason: SuppressionReason): string {
  switch (reason) {
    case SuppressionReason.HARD_BOUNCE:
      return "bounce";
    case SuppressionReason.COMPLAINT:
      return "complaint";
    default:
      return "manual";
  }
}

function formatSuppression(s: {
  id: string;
  email: string;
  reason: SuppressionReason;
  source: string | null;
  createdAt: Date;
}) {
  return {
    object: "suppression",
    id: s.id,
    email: s.email,
    reason: toReasonLabel(s.reason),
    source: s.source,
    created_at: s.createdAt.toISOString(),
  };
}

export function registerSuppressionRoutes(app: ResendApp): void {
  // GET /suppressions — list
  app.get("/suppressions", async (c) => {
    const team = c.var.team;
    const limitRaw = c.req.query("limit");
    const page = Number(c.req.query("page") ?? "1") || 1;
    const limit = Math.min(Number(limitRaw) || 20, 100);
    const search = c.req.query("email");
    const reasonRaw = c.req.query("reason");

    let reason: SuppressionReason | null = null;
    if (reasonRaw) {
      reason = toPrismaReason(reasonRaw);
    }

    const result = await SuppressionService.getSuppressionList({
      teamId: team.id,
      page,
      limit,
      search,
      reason,
    });

    return c.json(
      {
        object: "list",
        has_more: page * limit < result.total,
        total: result.total,
        data: result.suppressions.map(formatSuppression),
      },
      200,
    );
  });

  // POST /suppressions — add one
  app.post("/suppressions", async (c) => {
    const team = c.var.team;
    const raw = addSuppressionSchema.parse(await readJsonBody(c));

    const suppression = await SuppressionService.addSuppression({
      email: raw.email,
      teamId: team.id,
      reason: toPrismaReason(raw.reason),
    });

    return c.json(formatSuppression(suppression), 201);
  });

  // DELETE /suppressions/:email — remove one
  app.delete("/suppressions/:email", async (c) => {
    const team = c.var.team;
    const email = decodeURIComponent(c.req.param("email"));

    if (!email || !email.includes("@")) {
      throw new ResendApiError(
        "validation_error",
        "Invalid email address in path.",
      );
    }

    await SuppressionService.removeSuppression(email, team.id);

    return c.json({ object: "suppression", email, deleted: true }, 200);
  });
}
