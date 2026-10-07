/**
 * Pretty-printing helpers for CLI output.
 * All output is black/white — no colour codes, no emoji.
 */

import type { ApiResult } from "./api.js";

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function printLine(text: string): void {
  process.stdout.write(text + "\n");
}

export function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

export function handleResult<T>(result: ApiResult<T>): void {
  if (!result.ok) {
    printError(`${result.statusCode} ${result.name}: ${result.message}`);
    process.exit(1);
  }
  printJson(result.data);
}
