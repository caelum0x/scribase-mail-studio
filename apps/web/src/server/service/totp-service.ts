import { Prisma } from "@prisma/client";
/**
 * TotpService – TOTP-based MFA via otplib v13 (MIT licence).
 *
 * Enrollment flow:
 *   1. generateEnrollment(userId, accountLabel)  → { secret, otpauthUrl, qrDataUri }
 *   2. confirmEnrollment(userId, secret, token)  → { recoveryCodes }
 *      stores hashed recovery codes; sets totpEnabled = true
 *   3. verifyChallenge(userId, token) → true | false
 *
 * Recovery flow:
 *   verifyRecoveryCode(userId, code) → true | false  (one-time use; burns the code)
 *
 * Admin reset:
 *   disableTotp(userId) → void
 */
import { generateSecret, generate, verify, generateURI } from "otplib";
import QRCode from "qrcode";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "~/server/db";

// ─── Configuration ────────────────────────────────────────────────────────────

const ISSUER = "Scribase Mail";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10; // → 20-char hex string

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** SHA-256 hex of a recovery code. */
function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.toLowerCase()).digest("hex");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type TotpEnrollment = {
  secret: string;
  otpauthUrl: string;
  qrDataUri: string;
};

export type TotpConfirmResult = {
  recoveryCodes: string[];
};

/**
 * Generate a new TOTP secret for enrollment. Saves the *un-activated* secret
 * to the user row (totpEnabled remains false). The secret is NOT active until
 * `confirmEnrollment` succeeds.
 */
export async function generateEnrollment(
  userId: number,
  accountLabel: string,
): Promise<TotpEnrollment> {
  const secret = generateSecret();
  const otpauthUrl = generateURI({
    issuer: ISSUER,
    label: accountLabel,
    secret,
  });
  const qrDataUri = await QRCode.toDataURL(otpauthUrl, { margin: 1 });

  // Persist the unactivated secret so confirmEnrollment can verify against it.
  await db.user.update({
    where: { id: userId },
    data: { totpSecret: secret, totpEnabled: false },
  });

  return { secret, otpauthUrl, qrDataUri };
}

/**
 * Confirm a TOTP enrollment by verifying the user's first token.
 * Returns one-time recovery codes (shown once, never stored in plain text).
 * Throws if the token is invalid or there is no pending secret.
 */
export async function confirmEnrollment(
  userId: number,
  secret: string,
  token: string,
): Promise<TotpConfirmResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true },
  });

  if (!user?.totpSecret) {
    throw new Error("No pending TOTP enrollment for this user");
  }

  if (user.totpSecret !== secret) {
    throw new Error("Secret mismatch – restart enrollment");
  }

  const result = await verify({ secret, token });
  if (!result.valid) {
    throw new Error("Invalid TOTP token");
  }

  // Generate recovery codes (plain text returned once; hashes stored).
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBytes(RECOVERY_CODE_BYTES).toString("hex"),
  );
  const hashes = recoveryCodes.map(hashRecoveryCode);

  await db.user.update({
    where: { id: userId },
    data: {
      totpEnabled: true,
      totpRecoveryCodes: hashes,
    },
  });

  return { recoveryCodes };
}

/**
 * Verify a TOTP token during sign-in challenge.
 * Returns true if valid; false if invalid. Never throws.
 */
export async function verifyChallenge(
  userId: number,
  token: string,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true, totpEnabled: true },
  });

  if (!user?.totpSecret || !user.totpEnabled) return false;

  const result = await verify({ secret: user.totpSecret, token });
  return result.valid;
}

/**
 * Verify a one-time recovery code. If valid, the code is burned.
 * Returns true if the code was valid and has been consumed; false otherwise.
 */
export async function verifyRecoveryCode(
  userId: number,
  rawCode: string,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { totpRecoveryCodes: true, totpEnabled: true },
  });

  if (!user?.totpEnabled) return false;

  const hashes = (user.totpRecoveryCodes as string[] | null) ?? [];
  const candidateHash = hashRecoveryCode(rawCode);

  const matchIndex = hashes.findIndex((h) =>
    timingSafeEqualStr(h, candidateHash),
  );

  if (matchIndex === -1) return false;

  // Burn the used code.
  const updated = hashes.filter((_, i) => i !== matchIndex);
  await db.user.update({
    where: { id: userId },
    data: { totpRecoveryCodes: updated },
  });

  return true;
}

/**
 * Disable TOTP for a user (self-service or admin reset).
 */
export async function disableTotp(userId: number): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: {
      totpSecret: null,
      totpEnabled: false,
      totpRecoveryCodes: Prisma.DbNull,
    },
  });
}

/**
 * Regenerate recovery codes for a user who still has TOTP enabled.
 * Returns the new plain-text codes.
 */
export async function regenerateRecoveryCodes(
  userId: number,
): Promise<string[]> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { totpEnabled: true },
  });
  if (!user?.totpEnabled) throw new Error("TOTP is not enabled for this user");

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBytes(RECOVERY_CODE_BYTES).toString("hex"),
  );
  const hashes = recoveryCodes.map(hashRecoveryCode);

  await db.user.update({
    where: { id: userId },
    data: { totpRecoveryCodes: hashes },
  });

  return recoveryCodes;
}

/**
 * Returns the number of remaining recovery codes without revealing their values.
 */
export async function getRemainingRecoveryCodeCount(
  userId: number,
): Promise<number> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { totpRecoveryCodes: true },
  });
  const hashes = (user?.totpRecoveryCodes as string[] | null) ?? [];
  return hashes.length;
}
