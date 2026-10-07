-- Resend parity (Wave 0): schema for the Resend-compatible API and later waves
-- (tags, attachments/CID, shares, topics, segments, contact properties, template
-- versions, API request logs, audit log, inbound email, Svix webhook signing,
-- custom return path / TLS / tracking subdomain) plus the 10 req/s default rate limit.

-- CreateEnum
CREATE TYPE "WebhookSignatureFormat" AS ENUM ('USESEND', 'SVIX');

-- CreateEnum
CREATE TYPE "DomainTlsMode" AS ENUM ('OPPORTUNISTIC', 'ENFORCED');

-- CreateEnum
CREATE TYPE "TopicSubscription" AS ENUM ('OPT_IN', 'OPT_OUT');

-- CreateEnum
CREATE TYPE "TopicVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ContactPropertyType" AS ENUM ('STRING', 'NUMBER');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'API_KEY', 'SYSTEM');

-- AlterTable
ALTER TABLE "Team" ALTER COLUMN "apiRateLimit" SET DEFAULT 10;

-- AlterTable
ALTER TABLE "Domain" ADD COLUMN     "customReturnPath" TEXT,
ADD COLUMN     "receivingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "returnPathProviderId" TEXT,
ADD COLUMN     "returnPathStatus" TEXT,
ADD COLUMN     "sendingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tlsMode" "DomainTlsMode" NOT NULL DEFAULT 'OPPORTUNISTIC',
ADD COLUMN     "trackingSubdomain" TEXT;

-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "tags" JSONB,
ADD COLUMN     "topicId" TEXT;

-- AlterTable
ALTER TABLE "ContactBook" ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "topicId" TEXT;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "alias" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "variables" JSONB;

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "previousSecret" TEXT,
ADD COLUMN     "previousSecretExpiresAt" TIMESTAMP(3),
ADD COLUMN     "signatureFormat" "WebhookSignatureFormat" NOT NULL DEFAULT 'USESEND';

-- CreateTable
CREATE TABLE "EmailAttachment" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "contentId" TEXT,
    "inline" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" INTEGER,
    "sourceUrl" TEXT,
    "storageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailShare" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultSubscription" "TopicSubscription" NOT NULL DEFAULT 'OPT_IN',
    "visibility" "TopicVisibility" NOT NULL DEFAULT 'PRIVATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactTopic" (
    "contactId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "subscription" "TopicSubscription" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactTopic_pkey" PRIMARY KEY ("contactId","topicId")
);

-- CreateTable
CREATE TABLE "Segment" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentContact" (
    "segmentId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegmentContact_pkey" PRIMARY KEY ("segmentId","contactId")
);

-- CreateTable
CREATE TABLE "ContactProperty" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "type" "ContactPropertyType" NOT NULL,
    "fallbackValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT,
    "content" TEXT,
    "variables" JSONB,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "apiKeyId" INTEGER,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "requestBody" JSONB,
    "responseBody" JSONB,
    "errorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorUserId" INTEGER,
    "actorApiKeyId" INTEGER,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivedEmail" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "domainId" INTEGER,
    "messageId" TEXT,
    "from" TEXT NOT NULL,
    "to" TEXT[],
    "cc" TEXT[],
    "bcc" TEXT[],
    "replyTo" TEXT[],
    "subject" TEXT NOT NULL,
    "text" TEXT,
    "html" TEXT,
    "headers" JSONB,
    "rawStorageKey" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "spfResult" TEXT,
    "dkimResult" TEXT,
    "dmarcResult" TEXT,
    "spamScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivedEmailAttachment" (
    "id" TEXT NOT NULL,
    "receivedEmailId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "contentId" TEXT,
    "contentDisposition" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivedEmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailAttachment_emailId_idx" ON "EmailAttachment"("emailId");

-- CreateIndex
CREATE INDEX "EmailAttachment_teamId_idx" ON "EmailAttachment"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailShare_token_key" ON "EmailShare"("token");

-- CreateIndex
CREATE INDEX "EmailShare_emailId_idx" ON "EmailShare"("emailId");

-- CreateIndex
CREATE INDEX "Topic_teamId_idx" ON "Topic"("teamId");

-- CreateIndex
CREATE INDEX "ContactTopic_topicId_idx" ON "ContactTopic"("topicId");

-- CreateIndex
CREATE INDEX "Segment_teamId_idx" ON "Segment"("teamId");

-- CreateIndex
CREATE INDEX "SegmentContact_contactId_idx" ON "SegmentContact"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactProperty_teamId_key_key" ON "ContactProperty"("teamId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_key" ON "TemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "ApiRequestLog_teamId_createdAt_idx" ON "ApiRequestLog"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ApiRequestLog_createdAt_idx" ON "ApiRequestLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_teamId_createdAt_idx" ON "AuditLog"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ReceivedEmail_teamId_createdAt_idx" ON "ReceivedEmail"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ReceivedEmail_messageId_idx" ON "ReceivedEmail"("messageId");

-- CreateIndex
CREATE INDEX "ReceivedEmailAttachment_receivedEmailId_idx" ON "ReceivedEmailAttachment"("receivedEmailId");

-- CreateIndex
CREATE UNIQUE INDEX "Template_teamId_alias_key" ON "Template"("teamId", "alias");

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAttachment" ADD CONSTRAINT "EmailAttachment_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailShare" ADD CONSTRAINT "EmailShare_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTopic" ADD CONSTRAINT "ContactTopic_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTopic" ADD CONSTRAINT "ContactTopic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Segment" ADD CONSTRAINT "Segment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentContact" ADD CONSTRAINT "SegmentContact_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentContact" ADD CONSTRAINT "SegmentContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProperty" ADD CONSTRAINT "ContactProperty_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivedEmail" ADD CONSTRAINT "ReceivedEmail_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivedEmail" ADD CONSTRAINT "ReceivedEmail_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivedEmailAttachment" ADD CONSTRAINT "ReceivedEmailAttachment_receivedEmailId_fkey" FOREIGN KEY ("receivedEmailId") REFERENCES "ReceivedEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Teams still on the old default (2 req/s) move to the Resend default. Teams with a
-- custom limit keep it.
UPDATE "Team" SET "apiRateLimit" = 10 WHERE "apiRateLimit" = 2;
