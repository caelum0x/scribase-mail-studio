/**
 * Core MCP server factory.
 * Called by both the stdio entry point (index.ts) and the HTTP entry point
 * (http.ts) so transport selection stays isolated.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScribaseMailClient, resolveApiKey, DEFAULT_BASE_URL } from "./client.js";
import { registerTools } from "./tools.js";

export interface ServerOptions {
  /** Scribase Mail (or Resend-compatible) API key. Falls back to SCRIBASE_MAIL_API_KEY / RESEND_API_KEY. */
  apiKey?: string;
  /** Base URL for the Scribase Mail API. Defaults to https://mail-api.scribase.com */
  baseUrl?: string;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const apiKey = resolveApiKey(options.apiKey);
  const baseUrl = options.baseUrl ?? process.env["SCRIBASE_MAIL_BASE_URL"] ?? DEFAULT_BASE_URL;
  const client = new ScribaseMailClient(apiKey, baseUrl);

  const server = new McpServer({
    name: "scribase-mail",
    version: "0.1.0",
  });

  registerTools(server, client);

  return server;
}
