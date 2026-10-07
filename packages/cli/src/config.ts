/**
 * Persists the user's API key to ~/.config/scribase-mail/config.json (mode 600).
 * Falls back to the SCRIBASE_MAIL_API_KEY and RESEND_API_KEY env vars.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface CliConfig {
  apiKey?: string;
  baseUrl?: string;
}

export const CONFIG_DIR = join(homedir(), ".config", "scribase-mail");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function readConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: CliConfig): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  chmodSync(CONFIG_FILE, 0o600);
}

/** Resolve the API key: env > stored config. Returns undefined if not found. */
export function getApiKey(): string | undefined {
  return (
    process.env["SCRIBASE_MAIL_API_KEY"] ??
    process.env["RESEND_API_KEY"] ??
    readConfig().apiKey
  );
}

export function requireApiKey(): string {
  const key = getApiKey();
  if (!key) {
    throw new Error(
      "API key not set. Run `scribase-mail login` or set SCRIBASE_MAIL_API_KEY.",
    );
  }
  return key;
}

export function getBaseUrl(): string {
  return (
    process.env["SCRIBASE_MAIL_BASE_URL"] ??
    process.env["RESEND_BASE_URL"] ??
    readConfig().baseUrl ??
    "https://mail-api.scribase.com"
  );
}
