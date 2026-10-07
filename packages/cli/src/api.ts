/**
 * Thin fetch wrapper used by CLI commands.
 * Mirrors the ScribaseMailClient in mcp-server/src/client.ts but is
 * kept independent so the CLI has no dependency on the MCP server package.
 */

import { requireApiKey, getBaseUrl } from "./config.js";

export function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "scribase-mail-cli/0.1.0",
  };
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; statusCode: number; name: string; message: string };

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const apiKey = requireApiKey();
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;
  const init: RequestInit = {
    method,
    headers: buildHeaders(apiKey),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      statusCode: res.status,
      name: "parse_error",
      message: text.slice(0, 200),
    };
  }

  if (!res.ok) {
    const err = json as { statusCode?: number; name?: string; message?: string };
    return {
      ok: false,
      statusCode: err.statusCode ?? res.status,
      name: err.name ?? "api_error",
      message: err.message ?? res.statusText,
    };
  }
  return { ok: true, data: json as T };
}

export const api = {
  get: <T>(path: string) => apiRequest<T>("GET", path),
  post: <T>(path: string, body: unknown) => apiRequest<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => apiRequest<T>("PATCH", path, body),
  delete: <T>(path: string) => apiRequest<T>("DELETE", path),
};
