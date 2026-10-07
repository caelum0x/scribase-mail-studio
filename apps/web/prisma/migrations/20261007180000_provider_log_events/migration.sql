-- Email Delivery log records already processed by the delivery log poll job.
CREATE TABLE "ProcessedProviderLogEvent" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "messageId" TEXT,
    "recipient" TEXT,
    "emailId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedProviderLogEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessedProviderLogEvent_createdAt_idx" ON "ProcessedProviderLogEvent"("createdAt");
