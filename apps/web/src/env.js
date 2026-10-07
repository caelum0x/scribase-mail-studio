import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    DATABASE_URL: z
      .string()
      .url()
      .refine(
        (str) => !str.includes("YOUR_MYSQL_URL_HERE"),
        "You forgot to change the default URL",
      ),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    NEXTAUTH_SECRET:
      process.env.NODE_ENV === "production"
        ? z.string()
        : z.string().optional(),
    NEXTAUTH_URL: z.preprocess(
      // This makes Vercel deployments not fail if you don't set NEXTAUTH_URL
      // Since NextAuth.js automatically uses the VERCEL_URL if present.
      (str) => process.env.VERCEL_URL ?? str,
      // VERCEL_URL doesn't include `https` so it cant be validated as a URL
      process.env.VERCEL ? z.string() : z.string().url(),
    ),
    GITHUB_ID: z.string().optional(),
    GITHUB_SECRET: z.string().optional(),
    USESEND_API_KEY: z.string().optional(),
    UNSEND_API_KEY: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    // Oracle Cloud Infrastructure (OCI) Email Delivery
    OCI_REGION: z
      .string()
      .trim()
      .min(1, "Region is required")
      .default("eu-frankfurt-1"),
    OCI_COMPARTMENT_ID: z.string().optional(),
    OCI_TENANCY: z.string().optional(),
    OCI_USER: z.string().optional(),
    OCI_FINGERPRINT: z.string().optional(),
    OCI_PRIVATE_KEY: z.string().optional(),
    OCI_PRIVATE_KEY_PATH: z.string().optional(),
    OCI_PRIVATE_KEY_PASSPHRASE: z.string().optional(),
    // SMTP relay used for sending (OCI Email Delivery SMTP credentials)
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.string().default("587"),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    // How often the provider suppression list is polled for bounces/complaints
    SUPPRESSION_POLL_CRON: z.string().default("*/5 * * * *"),
    REPUTATION_GUARD_CRON: z.string().default("*/10 * * * *"),
    // Content screening of every outgoing email (links, attachments, spam signals)
    CONTENT_SCREENING_ENABLED: z
      .string()
      .default("true")
      .transform((str) => str !== "false"),
    // Plain-text threat feeds (one domain/URL per line), comma separated.
    // Default: Phishing.Database active phishing domains (MIT licensed).
    SCREENING_FEED_URLS: z
      .string()
      .default(
        "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt",
      ),
    SCREENING_FEED_CRON: z.string().default("17 */6 * * *"),
    SCREENING_ALLOWLIST_DOMAINS: z.string().optional(),
    SCREENING_BLOCKED_DOMAINS: z.string().optional(),
    // First-sends review for new teams (both 0 disables it)
    FIRST_SENDS_REVIEW_EMAILS: z
      .string()
      .optional()
      .transform((str) => (str ? parseInt(str, 10) : undefined)),
    FIRST_SENDS_REVIEW_HOURS: z
      .string()
      .optional()
      .transform((str) => (str ? parseInt(str, 10) : undefined)),
    API_RATE_LIMIT: z
      .string()
      .default("1")
      .transform((str) => parseInt(str, 10)),
    AUTH_EMAIL_RATE_LIMIT: z
      .string()
      .default("0")
      .transform((str) => parseInt(str, 10)),
    FROM_EMAIL: z.string().optional(),
    ADMIN_EMAIL: z.string().optional(),
    FOUNDER_EMAIL: z.string().optional(),
    DISCORD_WEBHOOK_URL: z.string().optional(),
    REDIS_URL: z.string(),
    REDIS_KEY_PREFIX: z.string().default(""),
    // Image uploads for the email editor (OCI Object Storage)
    OCI_STORAGE_NAMESPACE: z.string().optional(),
    OCI_STORAGE_BUCKET: z.string().optional(),
    STORAGE_PUBLIC_URL: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_BASIC_PRICE_ID: z.string().optional(),
    STRIPE_BASIC_USAGE_PRICE_ID: z.string().optional(),
    STRIPE_LEGACY_BASIC_PRICE_ID: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Public host/user shown to customers for the Scribase Mail SMTP proxy (apps/smtp-server)
    SMTP_PUBLIC_HOST: z.string().default("smtp.mail.scribase.com"),
    SMTP_PUBLIC_USER: z.string().default("scribase"),
    CONTACT_BOOK_ID: z.string().optional(),
    EMAIL_CLEANUP_DAYS: z
        .string()
        .optional()
        .transform((str) => (str ? parseInt(str, 10) : undefined)),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
    NEXT_PUBLIC_IS_CLOUD: z
      .string()
      .default("false")
      .transform((str) => str === "true"),
    NEXT_PUBLIC_APP_VERSION: z.string().optional(),
    NEXT_PUBLIC_GIT_SHA: z.string().optional(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    GITHUB_ID: process.env.GITHUB_ID,
    GITHUB_SECRET: process.env.GITHUB_SECRET,
    USESEND_API_KEY: process.env.USESEND_API_KEY,
    UNSEND_API_KEY: process.env.UNSEND_API_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    OCI_REGION: process.env.OCI_REGION,
    OCI_COMPARTMENT_ID: process.env.OCI_COMPARTMENT_ID,
    OCI_TENANCY: process.env.OCI_TENANCY,
    OCI_USER: process.env.OCI_USER,
    OCI_FINGERPRINT: process.env.OCI_FINGERPRINT,
    OCI_PRIVATE_KEY: process.env.OCI_PRIVATE_KEY,
    OCI_PRIVATE_KEY_PATH: process.env.OCI_PRIVATE_KEY_PATH,
    OCI_PRIVATE_KEY_PASSPHRASE: process.env.OCI_PRIVATE_KEY_PASSPHRASE,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_PASS: process.env.SMTP_PASS,
    SUPPRESSION_POLL_CRON: process.env.SUPPRESSION_POLL_CRON,
    REPUTATION_GUARD_CRON: process.env.REPUTATION_GUARD_CRON,
    CONTENT_SCREENING_ENABLED: process.env.CONTENT_SCREENING_ENABLED,
    SCREENING_FEED_URLS: process.env.SCREENING_FEED_URLS,
    SCREENING_FEED_CRON: process.env.SCREENING_FEED_CRON,
    SCREENING_ALLOWLIST_DOMAINS: process.env.SCREENING_ALLOWLIST_DOMAINS,
    SCREENING_BLOCKED_DOMAINS: process.env.SCREENING_BLOCKED_DOMAINS,
    FIRST_SENDS_REVIEW_EMAILS: process.env.FIRST_SENDS_REVIEW_EMAILS,
    FIRST_SENDS_REVIEW_HOURS: process.env.FIRST_SENDS_REVIEW_HOURS,
    API_RATE_LIMIT: process.env.API_RATE_LIMIT,
    AUTH_EMAIL_RATE_LIMIT: process.env.AUTH_EMAIL_RATE_LIMIT,
    NEXT_PUBLIC_IS_CLOUD: process.env.NEXT_PUBLIC_IS_CLOUD,
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
    NEXT_PUBLIC_GIT_SHA: process.env.NEXT_PUBLIC_GIT_SHA,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    FOUNDER_EMAIL: process.env.FOUNDER_EMAIL,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    REDIS_URL: process.env.REDIS_URL,
    REDIS_KEY_PREFIX: process.env.REDIS_KEY_PREFIX,
    FROM_EMAIL: process.env.FROM_EMAIL,
    OCI_STORAGE_NAMESPACE: process.env.OCI_STORAGE_NAMESPACE,
    OCI_STORAGE_BUCKET: process.env.OCI_STORAGE_BUCKET,
    STORAGE_PUBLIC_URL: process.env.STORAGE_PUBLIC_URL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_BASIC_PRICE_ID: process.env.STRIPE_BASIC_PRICE_ID,
    STRIPE_BASIC_USAGE_PRICE_ID: process.env.STRIPE_BASIC_USAGE_PRICE_ID,
    STRIPE_LEGACY_BASIC_PRICE_ID: process.env.STRIPE_LEGACY_BASIC_PRICE_ID,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PUBLIC_HOST: process.env.SMTP_PUBLIC_HOST,
    SMTP_PUBLIC_USER: process.env.SMTP_PUBLIC_USER,
    CONTACT_BOOK_ID: process.env.CONTACT_BOOK_ID,
    EMAIL_CLEANUP_DAYS: process.env.EMAIL_CLEANUP_DAYS,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
