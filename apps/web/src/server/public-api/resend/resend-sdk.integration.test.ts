/**
 * Integration acceptance test: the official `resend` SDK against the
 * Resend-compatible API with a real Postgres (Prisma) and Redis (auth,
 * rate limit, idempotency). Only the BullMQ queue and the outbound mailer
 * are stubbed, so nothing is actually sent.
 *
 *   RUN_INTEGRATION=true DATABASE_URL=... REDIS_URL=... \
 *     pnpm vitest run -c vitest.integration.config.ts src/server/public-api/resend
 */
import { ApiPermission } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Resend } from "resend";

const { mockQueueEmail } = vi.hoisted(() => ({ mockQueueEmail: vi.fn() }));

vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: { queueEmail: mockQueueEmail },
}));
vi.mock("~/server/mailer", () => ({ sendMail: vi.fn() }));
vi.mock("~/utils/common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/utils/common")>()),
  isSelfHosted: () => false,
}));

import { db } from "~/server/db";
import { addApiKey } from "~/server/service/api-service";
import { buildResendApp } from "~/server/public-api/resend";
import { createTeam } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
  resetRedis,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;
const BASE_URL = "https://api.mail.scribase.test";

describeIntegration("resend SDK against the compat API (Postgres + Redis)", () => {
  const realFetch = globalThis.fetch;
  let fullKey: string;
  let sendingKey: string;
  let teamId: number;

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    mockQueueEmail.mockResolvedValue(undefined);

    const team = await createTeam({ name: "Compat Team" });
    teamId = team.id;
    await db.domain.create({
      data: { name: "acme.dev", teamId, status: "SUCCESS", region: "eu-frankfurt-1" },
    });
    fullKey = await addApiKey({ name: "full", permission: ApiPermission.FULL, teamId });
    sendingKey = await addApiKey({ name: "send", permission: ApiPermission.SENDING, teamId });

    const app = buildResendApp();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      // Same rewrite Caddy performs for mail-api.scribase.com.
      const rewritten = new URL(`/api/resend${url.pathname}${url.search}`, "http://localhost");
      return app.fetch(new Request(rewritten, request));
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  it("new teams get the 10 req/s Resend default", async () => {
    const team = await db.team.findUniqueOrThrow({ where: { id: teamId } });
    expect(team.apiRateLimit).toBe(10);
  });

  it("emails.send + emails.get round-trip through Postgres", async () => {
    const resend = new Resend(fullKey, { baseUrl: BASE_URL });
    const sent = await resend.emails.send({
      from: "Acme <hello@acme.dev>",
      to: ["user@example.com"],
      subject: "Welcome",
      html: "<p>Hi</p>",
      replyTo: "support@acme.dev",
      tags: [{ name: "category", value: "welcome" }],
    });
    expect(sent.error).toBeNull();
    expect(sent.data?.id).toEqual(expect.any(String));

    const row = await db.email.findUniqueOrThrow({ where: { id: sent.data!.id } });
    expect(row).toMatchObject({
      teamId,
      latestStatus: "QUEUED",
      replyTo: ["support@acme.dev"],
      tags: [{ name: "category", value: "welcome" }],
    });

    const fetched = await resend.emails.get(sent.data!.id);
    expect(fetched.error).toBeNull();
    expect(fetched.data).toMatchObject({
      object: "email",
      id: sent.data!.id,
      from: "Acme <hello@acme.dev>",
      to: ["user@example.com"],
      subject: "Welcome",
      html: "<p>Hi</p>",
      reply_to: ["support@acme.dev"],
      last_event: "queued",
      tags: [{ name: "category", value: "welcome" }],
    });

    const list = await resend.emails.list({ limit: 1 });
    expect(list.data).toMatchObject({ object: "list", has_more: false });
    expect(list.data?.data[0]?.id).toBe(sent.data!.id);
  });

  it("scheduled_at schedules the email", async () => {
    const resend = new Resend(fullKey, { baseUrl: BASE_URL });
    const sent = await resend.emails.send({
      from: "hello@acme.dev",
      to: "user@example.com",
      subject: "Later",
      text: "Later",
      scheduledAt: "in 10 minutes",
    });
    expect(sent.error).toBeNull();
    const row = await db.email.findUniqueOrThrow({ where: { id: sent.data!.id } });
    expect(row.latestStatus).toBe("SCHEDULED");
    expect(row.scheduledAt!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(mockQueueEmail.mock.calls[0]![5]).toBeGreaterThan(9 * 60_000);
  });

  it("idempotency-key returns the original id for the same payload", async () => {
    const resend = new Resend(fullKey, { baseUrl: BASE_URL });
    const payload = { from: "hello@acme.dev", to: "u@example.com", subject: "Once", text: "x" };
    const first = await resend.emails.send(payload, { idempotencyKey: "order-1" });
    const second = await resend.emails.send(payload, { idempotencyKey: "order-1" });
    expect(second.data?.id).toBe(first.data?.id);
    expect(await db.email.count({ where: { teamId } })).toBe(1);

    const conflict = await resend.emails.send(
      { ...payload, subject: "Changed" },
      { idempotencyKey: "order-1" },
    );
    expect(conflict.error).toMatchObject({ statusCode: 409, name: "invalid_idempotent_request" });
  });

  it("sending-only keys send but cannot read", async () => {
    const resend = new Resend(sendingKey, { baseUrl: BASE_URL });
    const sent = await resend.emails.send({
      from: "hello@acme.dev",
      to: "user@example.com",
      subject: "Hi",
      text: "Hi",
    });
    expect(sent.error).toBeNull();
    const fetched = await resend.emails.get(sent.data!.id);
    expect(fetched.error).toMatchObject({ statusCode: 401, name: "restricted_api_key" });
  });

  it("invalid keys get invalid_api_key", async () => {
    const resend = new Resend("us_nope_nope", { baseUrl: BASE_URL });
    const { error } = await resend.emails.get("anything");
    expect(error).toMatchObject({ statusCode: 403, name: "invalid_api_key" });
  });
});
