import { env } from "~/env";
import { createOciProviderFromEnv } from "./oci/factory";
import type { EmailProvider } from "./types";

export * from "./types";

let provider: EmailProvider | null = null;

/** Returns the configured email provider (Oracle Cloud Email Delivery). */
export function getEmailProvider(): EmailProvider {
  if (!provider) {
    provider = createOciProviderFromEnv({
      OCI_REGION: env.OCI_REGION,
      OCI_COMPARTMENT_ID: env.OCI_COMPARTMENT_ID,
      OCI_TENANCY: env.OCI_TENANCY,
      OCI_USER: env.OCI_USER,
      OCI_FINGERPRINT: env.OCI_FINGERPRINT,
      OCI_PRIVATE_KEY: env.OCI_PRIVATE_KEY,
      OCI_PRIVATE_KEY_PATH: env.OCI_PRIVATE_KEY_PATH,
      OCI_PRIVATE_KEY_PASSPHRASE: env.OCI_PRIVATE_KEY_PASSPHRASE,
      SMTP_HOST: env.SMTP_HOST,
      SMTP_PORT: env.SMTP_PORT,
      SMTP_USER: env.SMTP_USER,
      SMTP_PASS: env.SMTP_PASS,
    });
  }
  return provider;
}

/** Region all sending queues and domains are bound to. */
export function getProviderRegion(): string {
  return env.OCI_REGION;
}

/** Test hook: replace the provider instance. */
export function setEmailProviderForTesting(next: EmailProvider | null) {
  provider = next;
}
