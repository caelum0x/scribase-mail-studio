import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Standard Webhooks secret: "whsec_" + base64 key.
const RAW_KEY = Buffer.from("scribase-mail-test-webhook-key-32b!");
const WEBHOOK_KEY = `whsec_${RAW_KEY.toString("base64")}`;

const { envState, processDodoWebhook, afterDodoWebhook } = vi.hoisted(() => ({
  envState: {
    current: {} as Record<string, string | undefined>,
  },
  processDodoWebhook: vi.fn(),
  afterDodoWebhook: vi.fn(),
}));

vi.mock("~/env", () => ({
  get env() {
    return envState.current;
  },
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/server/billing/webhook-handler", () => ({
  processDodoWebhook,
  afterDodoWebhook,
}));

import { POST } from "~/app/api/webhook/dodo/route";

function sign(id: string, timestamp: string, body: string) {
  const sig = createHmac("sha256", RAW_KEY)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${sig}`;
}

function request(body: string, headers: Record<string, string>) {
  return new Request("http://localhost/api/webhook/dodo", {
    method: "POST",
    body,
    headers,
  });
}

const BODY = JSON.stringify({
  business_id: "bus_1",
  type: "subscription.active",
  timestamp: "2026-10-07T00:00:00Z",
  data: { subscription_id: "sub_1" },
});

function signedHeaders(body = BODY, id = "wh_1") {
  const ts = Math.floor(Date.now() / 1000).toString();
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": sign(id, ts, body),
  };
}

describe("dodo webhook route", () => {
  beforeEach(() => {
    envState.current = {
      DODO_PAYMENTS_API_KEY: "test-key",
      DODO_PAYMENTS_WEBHOOK_KEY: WEBHOOK_KEY,
      DODO_PAYMENTS_ENVIRONMENT: "test_mode",
    };
    processDodoWebhook.mockReset();
    afterDodoWebhook.mockReset();
  });

  it("returns 400 when signature headers are missing", async () => {
    const res = await POST(request(BODY, {}));
    expect(res.status).toBe(400);
  });

  it("returns 503 when billing is not configured", async () => {
    envState.current = {};
    const res = await POST(request(BODY, signedHeaders()));
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toBe("Billing not configured");
  });

  it("rejects an invalid signature with 401", async () => {
    const headers = {
      ...signedHeaders(),
      "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    const res = await POST(request(BODY, headers));
    expect(res.status).toBe(401);
    expect(processDodoWebhook).not.toHaveBeenCalled();
  });

  it("rejects a tampered body", async () => {
    const res = await POST(
      request(BODY.replace("sub_1", "sub_2"), signedHeaders()),
    );
    expect(res.status).toBe(401);
  });

  it("processes a correctly signed event with its webhook-id", async () => {
    processDodoWebhook.mockResolvedValue({ status: "duplicate" });

    const res = await POST(request(BODY, signedHeaders(BODY, "wh_42")));

    expect(res.status).toBe(200);
    expect(processDodoWebhook).toHaveBeenCalledWith(
      "wh_42",
      expect.objectContaining({ type: "subscription.active" }),
    );
    expect(afterDodoWebhook).toHaveBeenCalledWith({ status: "duplicate" });
  });

  it("returns 500 so Dodo retries when processing fails", async () => {
    processDodoWebhook.mockRejectedValue(new Error("db down"));
    const res = await POST(request(BODY, signedHeaders()));
    expect(res.status).toBe(500);
  });
});
