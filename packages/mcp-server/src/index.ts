#!/usr/bin/env node
/**
 * Stdio transport entry point.
 *
 * Usage:
 *   SCRIBASE_MAIL_API_KEY=sm_... npx @scribase-mail/mcp-server
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "scribase-mail": {
 *         "command": "npx",
 *         "args": ["@scribase-mail/mcp-server"],
 *         "env": { "SCRIBASE_MAIL_API_KEY": "sm_..." }
 *       }
 *     }
 *   }
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`scribase-mail-mcp: fatal error: ${String(err)}\n`);
  process.exit(1);
});
