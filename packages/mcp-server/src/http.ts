/**
 * Streamable HTTP transport entry point.
 *
 * Run as a standalone Node.js server:
 *   SCRIBASE_MAIL_API_KEY=sm_... MCP_PORT=3100 node dist/http.js
 *
 * Or mount the exported handler in a Next.js API route (App Router):
 *
 *   // app/api/mcp/route.ts
 *   import { createWebHandler } from "@scribase-mail/mcp-server/http";
 *   export const POST = createWebHandler();
 *
 * When self-hosting Scribase Mail, Caddy can reverse-proxy
 * /mcp → this server so the MCP endpoint lives at
 * https://mail-api.scribase.com/mcp.
 */

import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "./server.js";

export interface HttpHandlerOptions {
  /** Scribase Mail API key. Falls back to SCRIBASE_MAIL_API_KEY env var. */
  apiKey?: string;
  /** Base URL override. Defaults to https://mail-api.scribase.com */
  baseUrl?: string;
}

/**
 * Create a Web Standards Request → Response handler for use in
 * Next.js / Cloudflare Workers / Deno / Bun.
 */
export function createWebHandler(options: HttpHandlerOptions = {}) {
  return async function handler(req: Request): Promise<Response> {
    const mcpServer = createServer(options);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await mcpServer.connect(transport);
    return transport.handleRequest(req);
  };
}

/**
 * Create a Node.js IncomingMessage / ServerResponse handler for use with
 * Express, Hono (Node adapter), or bare http.createServer.
 *
 * The body must already be parsed (pass as the third argument to `handleRequest`).
 */
export function createNodeHandler(options: HttpHandlerOptions = {}) {
  return async function handler(
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<void> {
    const mcpServer = createServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

// ─── Standalone server ────────────────────────────────────────────────────────

const PORT = parseInt(process.env["MCP_PORT"] ?? "3100", 10);

async function startStandaloneServer(): Promise<void> {
  const { createServer: createHttpServer } = await import("node:http");
  const nodeHandler = createNodeHandler();

  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end("Method Not Allowed");
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

      await nodeHandler(req, res, body);
    },
  );

  httpServer.listen(PORT, () => {
    process.stderr.write(`scribase-mail-mcp HTTP server listening on port ${PORT}\n`);
  });
}

// Only start the standalone server when this file is the entry point.
const fileUrl = new URL(`file://${process.argv[1] ?? ""}`).href;
const thisUrl = import.meta.url;
if (fileUrl === thisUrl) {
  startStandaloneServer().catch((err: unknown) => {
    process.stderr.write(`scribase-mail-mcp http: ${String(err)}\n`);
    process.exit(1);
  });
}
