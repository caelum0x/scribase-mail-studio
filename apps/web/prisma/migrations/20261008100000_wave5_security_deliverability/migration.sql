-- Wave 5: security (TOTP/MFA), deliverability insights, dedicated IPs / roles

-- Add DEVELOPER role to the Role enum (PostgreSQL safe approach)
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DEVELOPER';

-- Session: track 2FA verification within a session
ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "twoFactorVerifiedAt" TIMESTAMP(3);

-- User: TOTP enrollment fields
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "totpSecret"        TEXT,
  ADD COLUMN IF NOT EXISTS "totpEnabled"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "totpRecoveryCodes" JSONB;

-- Team: 2FA enforcement + dedicated IP pool
ALTER TABLE "Team"
  ADD COLUMN IF NOT EXISTS "requireTwoFactor" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sendingPool"      TEXT;
