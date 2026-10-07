import DodoPayments from "dodopayments";
import { env } from "~/env";
import type { ProductIds } from "./plan-mapping";

export class BillingNotConfiguredError extends Error {
  constructor(message = "Billing not configured") {
    super(message);
    this.name = "BillingNotConfiguredError";
  }
}

/** True when checkout can work: API key plus at least one plan product. */
export function isBillingConfigured(): boolean {
  return Boolean(
    env.DODO_PAYMENTS_API_KEY &&
      (env.DODO_PRODUCT_ID_PRO || env.DODO_PRODUCT_ID_SCALE),
  );
}

export function getProductIds(): ProductIds {
  return {
    PRO: env.DODO_PRODUCT_ID_PRO,
    SCALE: env.DODO_PRODUCT_ID_SCALE,
  };
}

let cached: DodoPayments | null = null;

export function getDodoClient(): DodoPayments {
  if (!env.DODO_PAYMENTS_API_KEY) {
    throw new BillingNotConfiguredError();
  }
  if (!cached) {
    cached = new DodoPayments({
      bearerToken: env.DODO_PAYMENTS_API_KEY,
      // Defaults to test_mode so a missing variable never hits live.
      environment:
        env.DODO_PAYMENTS_ENVIRONMENT === "live_mode"
          ? "live_mode"
          : "test_mode",
      webhookKey: env.DODO_PAYMENTS_WEBHOOK_KEY ?? null,
    });
  }
  return cached;
}
