import { Command } from "commander";
import { api } from "../api.js";
import { handleResult } from "../output.js";

export function makeDomainsCommand(): Command {
  const domains = new Command("domains").description("Manage sending domains");

  domains
    .command("list")
    .description("List all configured domains")
    .action(async () => {
      handleResult(await api.get("/domains"));
    });

  domains
    .command("get <id>")
    .description("Retrieve a domain by ID (includes DNS records)")
    .action(async (id: string) => {
      handleResult(await api.get(`/domains/${id}`));
    });

  domains
    .command("add")
    .description("Add a new sending domain")
    .requiredOption("--name <domain>", "Domain name, e.g. mail.example.com")
    .option(
      "--region <region>",
      "OCI region: us-east-1 | eu-west-1 | sa-east-1 | ap-northeast-1",
    )
    .action(async (opts: { name: string; region?: string }) => {
      const body: Record<string, unknown> = { name: opts.name };
      if (opts.region) body.region = opts.region;
      handleResult(await api.post("/domains", body));
    });

  domains
    .command("verify <id>")
    .description("Trigger DNS verification for a domain")
    .action(async (id: string) => {
      handleResult(await api.post(`/domains/${id}/verify`, {}));
    });

  domains
    .command("delete <id>")
    .description("Remove a domain from your account")
    .action(async (id: string) => {
      handleResult(await api.delete(`/domains/${id}`));
    });

  return domains;
}
