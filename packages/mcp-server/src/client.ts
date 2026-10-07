/**
 * Lightweight fetch client that talks to the Scribase Mail Resend-compatible
 * API at https://mail-api.scribase.com (or a custom base URL).
 */

export const DEFAULT_BASE_URL = "https://mail-api.scribase.com";

export class ScribaseMailClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, baseUrl = DEFAULT_BASE_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T | null; error: { statusCode: number; name: string; message: string } | null }> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers(),
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
        data: null,
        error: { statusCode: res.status, name: "parse_error", message: text },
      };
    }
    if (!res.ok) {
      const err = json as { statusCode?: number; name?: string; message?: string };
      return {
        data: null,
        error: {
          statusCode: err.statusCode ?? res.status,
          name: err.name ?? "api_error",
          message: err.message ?? res.statusText,
        },
      };
    }
    return { data: json as T, error: null };
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, body);
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }

  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }
}

/** Resolve the API key from constructor argument or environment variable. */
export function resolveApiKey(apiKey?: string): string {
  const key = apiKey ?? process.env["SCRIBASE_MAIL_API_KEY"] ?? process.env["RESEND_API_KEY"];
  if (!key) {
    throw new Error(
      "Scribase Mail API key not found. Set SCRIBASE_MAIL_API_KEY or pass it as the SCRIBASE_MAIL_API_KEY environment variable.",
    );
  }
  return key;
}
