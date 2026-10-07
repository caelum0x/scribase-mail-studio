-- Replace Stripe billing with provider-neutral billing (Dodo Payments).

-- Plans: FREE, PRO, SCALE. Existing BASIC teams become PRO.
ALTER TYPE "Plan" RENAME VALUE 'BASIC' TO 'PRO';
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'SCALE';

-- Team: provider-neutral customer id.
ALTER TABLE "Team" RENAME COLUMN "stripeCustomerId" TO "billingCustomerId";
ALTER INDEX "Team_stripeCustomerId_key" RENAME TO "Team_billingCustomerId_key";

-- Subscription: provider-neutral record.
ALTER TABLE "Subscription" RENAME COLUMN "priceId" TO "productId";
ALTER TABLE "Subscription" RENAME COLUMN "priceIds" TO "productIds";
ALTER TABLE "Subscription" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'dodo';
ALTER TABLE "Subscription" ADD COLUMN "customerId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'FREE';
-- Rows written by the old integration came from Stripe.
UPDATE "Subscription" s SET "provider" = 'stripe', "plan" = t."plan"
FROM "Team" t WHERE t."id" = s."teamId";
CREATE INDEX "Subscription_teamId_idx" ON "Subscription"("teamId");

-- Idempotency ledger for verified billing webhooks.
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'dodo',
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);
