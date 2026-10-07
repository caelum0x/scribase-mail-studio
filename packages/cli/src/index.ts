#!/usr/bin/env node
/**
 * Scribase Mail CLI
 *
 * Usage:
 *   scribase-mail login
 *   scribase-mail emails send --from noreply@example.com --to user@example.com \
 *     --subject "Hello" --html "<p>Hi</p>"
 *   scribase-mail emails list --limit 20
 *   scribase-mail domains add --name mail.example.com
 *   scribase-mail api-keys list
 *
 * Set SCRIBASE_MAIL_API_KEY or run `scribase-mail login` first.
 * Set SCRIBASE_MAIL_BASE_URL to point at a self-hosted instance.
 */

import { program } from "commander";
import { makeLoginCommand } from "./commands/login.js";
import { makeEmailsCommand } from "./commands/emails.js";
import { makeDomainsCommand } from "./commands/domains.js";
import { makeApiKeysCommand } from "./commands/api-keys.js";

program
  .name("scribase-mail")
  .description("Scribase Mail CLI — Resend-compatible email sending from the command line")
  .version("0.1.0");

program.addCommand(makeLoginCommand());
program.addCommand(makeEmailsCommand());
program.addCommand(makeDomainsCommand());
program.addCommand(makeApiKeysCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`scribase-mail: ${String(err)}\n`);
  process.exit(1);
});
