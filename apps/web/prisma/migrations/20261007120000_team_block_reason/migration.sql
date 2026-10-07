-- Why and when a team was paused (reputation guard or admin).
ALTER TABLE "Team" ADD COLUMN "blockedReason" TEXT;
ALTER TABLE "Team" ADD COLUMN "blockedAt" TIMESTAMP(3);
