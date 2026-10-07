import { Command } from "commander";
import * as readline from "node:readline/promises";
import { writeConfig, readConfig, CONFIG_FILE } from "../config.js";
import { printLine, printError } from "../output.js";
import { api } from "../api.js";

export function makeLoginCommand(): Command {
  return new Command("login")
    .description("Store your Scribase Mail API key in ~/.config/scribase-mail/config.json (mode 600)")
    .option("--key <key>", "API key (skips interactive prompt)")
    .option("--base-url <url>", "Override base URL (default: https://mail-api.scribase.com)")
    .action(async (opts: { key?: string; baseUrl?: string }) => {
      let apiKey = opts.key;
      if (!apiKey) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        apiKey = await rl.question("Enter your Scribase Mail API key: ");
        rl.close();
        apiKey = apiKey.trim();
      }

      if (!apiKey) {
        printError("API key cannot be empty.");
        process.exit(1);
      }

      // Validate the key by making a lightweight API call.
      process.env["SCRIBASE_MAIL_API_KEY"] = apiKey;
      if (opts.baseUrl) process.env["SCRIBASE_MAIL_BASE_URL"] = opts.baseUrl;

      const result = await api.get("/domains");
      if (!result.ok) {
        printError(`Key validation failed (${result.statusCode} ${result.name}): ${result.message}`);
        process.exit(1);
      }

      const existing = readConfig();
      writeConfig({ ...existing, apiKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
      printLine(`API key saved to ${CONFIG_FILE}`);
    });
}
