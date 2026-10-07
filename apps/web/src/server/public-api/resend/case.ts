/**
 * snake_case <-> camelCase helpers for the Resend-compatible API. Resend
 * request and response bodies are snake_case; our services are camelCase.
 *
 * Keys of free-form maps (custom `headers`, template `variables`, tag values,
 * contact `properties`) must keep the caller's spelling, so callers pass the
 * names of keys whose values are copied verbatim.
 */

export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

export function camelToSnake(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function convertKeys(
  value: unknown,
  convert: (key: string) => string,
  preserve: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => convertKeys(item, convert, preserve));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      const newKey = convert(key);
      const newValue =
        preserve.has(key) || preserve.has(newKey)
          ? inner
          : convertKeys(inner, convert, preserve);
      return [newKey, newValue];
    }),
  );
}

/** Deep-convert keys to camelCase. Values under `preserve` keys are copied as is. */
export function toCamelKeys<T = unknown>(
  value: unknown,
  preserve: Iterable<string> = [],
): T {
  return convertKeys(value, snakeToCamel, new Set(preserve)) as T;
}

/** Deep-convert keys to snake_case. Dates become ISO strings. */
export function toSnakeKeys<T = unknown>(
  value: unknown,
  preserve: Iterable<string> = [],
): T {
  return convertKeys(value, camelToSnake, new Set(preserve)) as T;
}
