/**
 * MCP tool definitions for Scribase Mail.
 *
 * Tools mirror the Resend MCP server surface
 * (https://github.com/resend/mcp-send-email) so that any Resend MCP
 * documentation is directly applicable.
 */

import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ScribaseMailClient } from "./client.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Format an API result as MCP tool content. */
function toContent(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorContent(err: { name: string; message: string; statusCode: number }) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error ${err.statusCode} (${err.name}): ${err.message}`,
      },
    ],
    isError: true,
  };
}

async function call<T>(
  fn: () => Promise<{ data: T | null; error: { statusCode: number; name: string; message: string } | null }>,
) {
  const { data, error } = await fn();
  if (error) return errorContent(error);
  return toContent(data);
}

// ─── Schema helpers ───────────────────────────────────────────────────────────

const addressListSchema = z
  .union([z.string(), z.array(z.string())])
  .describe("Email address or array of email addresses");

const tagSchema = z
  .array(z.object({ name: z.string(), value: z.string() }))
  .optional()
  .describe("Custom tags (name/value pairs, ASCII letters/numbers/_/- max 256 chars)");

// ─── Tool registration ─────────────────────────────────────────────────────────

export function registerTools(server: McpServer, client: ScribaseMailClient): void {
  // ── Emails ──────────────────────────────────────────────────────────────────

  server.tool(
    "send_email",
    "Send a transactional email. Supports HTML, plain text, attachments (base64), tags, and scheduled delivery.",
    {
      from: z.string().describe("Sender address, e.g. 'Name <user@domain.com>'"),
      to: addressListSchema,
      subject: z.string().optional().describe("Email subject"),
      html: z.string().optional().describe("HTML body"),
      text: z.string().optional().describe("Plain text body"),
      cc: addressListSchema.optional(),
      bcc: addressListSchema.optional(),
      reply_to: addressListSchema.optional(),
      headers: z.record(z.string()).optional().describe("Custom headers"),
      scheduled_at: z
        .string()
        .optional()
        .describe("ISO 8601 or natural language, e.g. 'in 1 hour', 'tomorrow at 9am'"),
      attachments: z
        .array(
          z.object({
            content: z.string().describe("Base64-encoded file content"),
            filename: z.string().describe("File name"),
          }),
        )
        .optional(),
      tags: tagSchema,
    },
    async (params) => {
      return call(() => client.post("/emails", params));
    },
  );

  server.tool(
    "batch_send_emails",
    "Send up to 100 emails in a single request. Each element follows the same shape as send_email.",
    {
      emails: z
        .array(
          z.object({
            from: z.string(),
            to: addressListSchema,
            subject: z.string().optional(),
            html: z.string().optional(),
            text: z.string().optional(),
            cc: addressListSchema.optional(),
            bcc: addressListSchema.optional(),
            reply_to: addressListSchema.optional(),
            headers: z.record(z.string()).optional(),
            scheduled_at: z.string().optional(),
            tags: tagSchema,
          }),
        )
        .max(100),
    },
    async ({ emails }) => {
      return call(() => client.post("/emails/batch", emails));
    },
  );

  server.tool(
    "get_email",
    "Retrieve a sent email by its ID.",
    { id: z.string().describe("Email ID") },
    async ({ id }) => {
      return call(() => client.get(`/emails/${id}`));
    },
  );

  server.tool(
    "list_emails",
    "List emails sent from your account. Supports cursor-based pagination.",
    {
      limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100, default 10)"),
      after: z.string().optional().describe("Cursor — return results after this ID"),
      before: z.string().optional().describe("Cursor — return results before this ID"),
    },
    async ({ limit, after, before }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (after) params.set("after", after);
      if (before) params.set("before", before);
      const qs = params.toString();
      return call(() => client.get(`/emails${qs ? `?${qs}` : ""}`));
    },
  );

  server.tool(
    "cancel_email",
    "Cancel a scheduled email before it is sent.",
    { id: z.string().describe("Email ID") },
    async ({ id }) => {
      return call(() => client.post(`/emails/${id}/cancel`, {}));
    },
  );

  server.tool(
    "reschedule_email",
    "Reschedule a scheduled email to a new delivery time.",
    {
      id: z.string().describe("Email ID"),
      scheduled_at: z
        .string()
        .describe("New delivery time: ISO 8601 or natural language"),
    },
    async ({ id, scheduled_at }) => {
      return call(() => client.patch(`/emails/${id}`, { scheduled_at }));
    },
  );

  // ── Domains ──────────────────────────────────────────────────────────────────

  server.tool(
    "list_domains",
    "List domains configured in your Scribase Mail account.",
    {},
    async () => {
      return call(() => client.get("/domains"));
    },
  );

  server.tool(
    "get_domain",
    "Retrieve a domain by ID, including its DNS verification records.",
    { id: z.string().describe("Domain ID") },
    async ({ id }) => {
      return call(() => client.get(`/domains/${id}`));
    },
  );

  server.tool(
    "create_domain",
    "Add a new sending domain. Returns the DNS records you must configure.",
    {
      name: z.string().describe("Domain name, e.g. 'mail.example.com'"),
      region: z
        .enum(["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"])
        .optional()
        .describe("OCI region for this domain"),
    },
    async (params) => {
      return call(() => client.post("/domains", params));
    },
  );

  server.tool(
    "verify_domain",
    "Trigger DNS verification for a domain after you have added the required records.",
    { id: z.string().describe("Domain ID") },
    async ({ id }) => {
      return call(() => client.post(`/domains/${id}/verify`, {}));
    },
  );

  server.tool(
    "delete_domain",
    "Remove a domain from your account.",
    { id: z.string().describe("Domain ID") },
    async ({ id }) => {
      return call(() => client.delete(`/domains/${id}`));
    },
  );

  // ── Contacts ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_contacts",
    "List contacts in an audience/contact book.",
    {
      audience_id: z.string().describe("Audience (contact book) ID"),
      limit: z.number().int().min(1).max(100).optional(),
      after: z.string().optional(),
    },
    async ({ audience_id, limit, after }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (after) params.set("after", after);
      const qs = params.toString();
      return call(() =>
        client.get(`/contacts?audience_id=${audience_id}${qs ? `&${qs}` : ""}`),
      );
    },
  );

  server.tool(
    "create_contact",
    "Add a contact to an audience.",
    {
      audience_id: z.string().describe("Audience (contact book) ID"),
      email: z.string().email(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      unsubscribed: z.boolean().optional(),
    },
    async ({ audience_id, ...contact }) => {
      return call(() => client.post(`/contacts`, { ...contact, audience_id }));
    },
  );

  // ── Broadcasts ───────────────────────────────────────────────────────────────

  server.tool(
    "list_broadcasts",
    "List broadcast campaigns.",
    {
      limit: z.number().int().min(1).max(100).optional(),
      after: z.string().optional(),
    },
    async ({ limit, after }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (after) params.set("after", after);
      const qs = params.toString();
      return call(() => client.get(`/broadcasts${qs ? `?${qs}` : ""}`));
    },
  );

  server.tool(
    "get_broadcast",
    "Retrieve a broadcast by ID.",
    { id: z.string().describe("Broadcast ID") },
    async ({ id }) => {
      return call(() => client.get(`/broadcasts/${id}`));
    },
  );

  // ── Received emails ──────────────────────────────────────────────────────────

  server.tool(
    "list_received_emails",
    "List inbound emails received at your Scribase Mail managed address.",
    {
      limit: z.number().int().min(1).max(100).optional(),
      after: z.string().optional(),
    },
    async ({ limit, after }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (after) params.set("after", after);
      const qs = params.toString();
      return call(() => client.get(`/emails/received${qs ? `?${qs}` : ""}`));
    },
  );

  server.tool(
    "get_received_email",
    "Retrieve a single inbound email by ID.",
    { id: z.string().describe("Received email ID") },
    async ({ id }) => {
      return call(() => client.get(`/emails/received/${id}`));
    },
  );
}
