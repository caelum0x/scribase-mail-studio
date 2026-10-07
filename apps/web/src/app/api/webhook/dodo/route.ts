import { NextResponse } from "next/server";
import { env } from "~/env";
import { getDodoClient } from "~/server/billing/dodo-client";
import {
  afterDodoWebhook,
  processDodoWebhook,
} from "~/server/billing/webhook-handler";
import { logger } from "~/server/logger/log";

/**
 * Dodo Payments webhook endpoint: POST /api/webhook/dodo
 *
 * Verified with the Standard Webhooks scheme (webhook-id, webhook-timestamp,
 * webhook-signature over "id.timestamp.raw_body") via the SDK's unwrap().
 * Responds 2xx only after the event is durably processed; any failure
 * returns 5xx so Dodo retries. Duplicates are acknowledged without effect.
 */
export async function POST(req: Request) {
  const webhookId = req.headers.get("webhook-id");
  const signature = req.headers.get("webhook-signature");
  const timestamp = req.headers.get("webhook-timestamp");

  if (!webhookId || !signature || !timestamp) {
    return new NextResponse("Missing webhook signature headers", {
      status: 400,
    });
  }

  if (!env.DODO_PAYMENTS_WEBHOOK_KEY || !env.DODO_PAYMENTS_API_KEY) {
    logger.error("[Billing]: Dodo webhook received but billing is not configured");
    return new NextResponse("Billing not configured", { status: 503 });
  }

  const body = await req.text();

  let event: { type: string; data: unknown };
  try {
    event = getDodoClient().webhooks.unwrap(body, {
      headers: {
        "webhook-id": webhookId,
        "webhook-signature": signature,
        "webhook-timestamp": timestamp,
      },
      key: env.DODO_PAYMENTS_WEBHOOK_KEY,
    });
  } catch (err) {
    logger.warn({ err, webhookId }, "[Billing]: Invalid Dodo webhook signature");
    return new NextResponse("Invalid signature", { status: 401 });
  }

  try {
    const outcome = await processDodoWebhook(webhookId, event);
    await afterDodoWebhook(outcome);
    return NextResponse.json({ received: true, status: outcome.status });
  } catch (err) {
    logger.error(
      { err, webhookId, type: event.type },
      "[Billing]: Failed to process Dodo webhook",
    );
    return new NextResponse("Webhook processing failed", { status: 500 });
  }
}
