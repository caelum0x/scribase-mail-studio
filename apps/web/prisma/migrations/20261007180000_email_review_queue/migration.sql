-- Content screening + first-sends review: emails can be HELD for an admin,
-- queued in "EmailReview"; teams can be marked trusted after review.

-- CreateEnum
CREATE TYPE "EmailReviewReason" AS ENUM ('CONTENT', 'FIRST_SENDS');

-- CreateEnum
CREATE TYPE "EmailReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'HELD';

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "sendingTrustedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailReview" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "reason" "EmailReviewReason" NOT NULL,
    "status" "EmailReviewStatus" NOT NULL DEFAULT 'PENDING',
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "findings" JSONB,
    "unsubUrl" TEXT,
    "isBulk" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" INTEGER,

    CONSTRAINT "EmailReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailReview_emailId_key" ON "EmailReview"("emailId");

-- CreateIndex
CREATE INDEX "EmailReview_status_createdAt_idx" ON "EmailReview"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EmailReview_teamId_status_idx" ON "EmailReview"("teamId", "status");

-- AddForeignKey
ALTER TABLE "EmailReview" ADD CONSTRAINT "EmailReview_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailReview" ADD CONSTRAINT "EmailReview_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

