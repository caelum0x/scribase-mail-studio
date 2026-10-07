import { Command } from "commander";
import { api } from "../api.js";
import { handleResult, printError } from "../output.js";

export function makeEmailsCommand(): Command {
  const emails = new Command("emails").description("Manage transactional emails");

  emails
    .command("send")
    .description("Send a transactional email")
    .requiredOption("--from <address>", "Sender address (e.g. 'Name <user@domain.com>')")
    .requiredOption("--to <address>", "Recipient address (repeat for multiple)", collect, [])
    .option("--subject <text>", "Email subject")
    .option("--html <html>", "HTML body")
    .option("--text <text>", "Plain text body")
    .option("--cc <address>", "CC address (repeat for multiple)", collect, [])
    .option("--bcc <address>", "BCC address (repeat for multiple)", collect, [])
    .option("--reply-to <address>", "Reply-To address")
    .option("--scheduled-at <datetime>", "Delivery time: ISO 8601 or natural language")
    .option("--tag <name=value>", "Tag name=value (repeat for multiple)", collectTag, [])
    .action(
      async (opts: {
        from: string;
        to: string[];
        subject?: string;
        html?: string;
        text?: string;
        cc: string[];
        bcc: string[];
        replyTo?: string;
        scheduledAt?: string;
        tag: Array<{ name: string; value: string }>;
      }) => {
        if (!opts.subject && !opts.html && !opts.text) {
          printError("Provide at least --subject and --html or --text.");
          process.exit(1);
        }
        const body: Record<string, unknown> = {
          from: opts.from,
          to: opts.to.length === 1 ? opts.to[0] : opts.to,
          ...(opts.subject ? { subject: opts.subject } : {}),
          ...(opts.html ? { html: opts.html } : {}),
          ...(opts.text ? { text: opts.text } : {}),
          ...(opts.cc.length > 0 ? { cc: opts.cc } : {}),
          ...(opts.bcc.length > 0 ? { bcc: opts.bcc } : {}),
          ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
          ...(opts.scheduledAt ? { scheduled_at: opts.scheduledAt } : {}),
          ...(opts.tag.length > 0 ? { tags: opts.tag } : {}),
        };
        handleResult(await api.post("/emails", body));
      },
    );

  emails
    .command("get <id>")
    .description("Retrieve a sent email by ID")
    .action(async (id: string) => {
      handleResult(await api.get(`/emails/${id}`));
    });

  emails
    .command("list")
    .description("List sent emails (cursor-paginated, newest first)")
    .option("--limit <n>", "Max results (1-100, default 10)", "10")
    .option("--after <id>", "Cursor — results after this email ID")
    .option("--before <id>", "Cursor — results before this email ID")
    .action(async (opts: { limit: string; after?: string; before?: string }) => {
      const params = new URLSearchParams({ limit: opts.limit });
      if (opts.after) params.set("after", opts.after);
      if (opts.before) params.set("before", opts.before);
      handleResult(await api.get(`/emails?${params.toString()}`));
    });

  emails
    .command("cancel <id>")
    .description("Cancel a scheduled email")
    .action(async (id: string) => {
      handleResult(await api.post(`/emails/${id}/cancel`, {}));
    });

  emails
    .command("reschedule <id>")
    .description("Reschedule a scheduled email to a new delivery time")
    .requiredOption("--at <datetime>", "New delivery time: ISO 8601 or natural language")
    .action(async (id: string, opts: { at: string }) => {
      handleResult(await api.patch(`/emails/${id}`, { scheduled_at: opts.at }));
    });

  return emails;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function collectTag(
  value: string,
  prev: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  const [name, ...rest] = value.split("=");
  const tagValue = rest.join("=");
  if (!name || tagValue === undefined) {
    printError(`Invalid tag format "${value}". Use name=value.`);
    process.exit(1);
  }
  return [...prev, { name, value: tagValue }];
}
