import { Command } from "commander";
import { api } from "../api.js";
import { handleResult } from "../output.js";

export function makeApiKeysCommand(): Command {
  const keys = new Command("api-keys").description("Manage API keys");

  keys
    .command("list")
    .description("List all API keys for the team")
    .action(async () => {
      handleResult(await api.get("/api-keys"));
    });

  keys
    .command("create")
    .description("Create a new API key")
    .requiredOption("--name <name>", "Key name")
    .option(
      "--permission <permission>",
      "full_access (default) or sending_access",
      "full_access",
    )
    .option("--domain-id <id>", "Restrict key to a specific domain ID")
    .action(
      async (opts: { name: string; permission: string; domainId?: string }) => {
        const body: Record<string, unknown> = {
          name: opts.name,
          permission: opts.permission,
        };
        if (opts.domainId) body.domain_id = opts.domainId;
        handleResult(await api.post("/api-keys", body));
      },
    );

  keys
    .command("delete <id>")
    .description("Revoke and delete an API key by ID")
    .action(async (id: string) => {
      handleResult(await api.delete(`/api-keys/${id}`));
    });

  return keys;
}
