/**
 * Personalization helpers (Wave 2 B2).
 *
 * Translates Resend `{{{contact.first_name|fallback}}}` syntax and the
 * built-in `RESEND_UNSUBSCRIBE_URL` variable into values sourced from a
 * contact record.  Works alongside the existing useSend `{{variable}}` system.
 */

const RESEND_UNSUB_VAR = "RESEND_UNSUBSCRIBE_URL";

/**
 * Expand Resend-style triple-moustache personalization:
 *   {{{contact.first_name|Valued Customer}}}
 *   {{{RESEND_UNSUBSCRIBE_URL}}}
 *
 * `contact` is a free-form record (can include firstName, lastName, email,
 * plus any typed properties).
 */
export function applyResendPersonalization(
  source: string,
  contact: Record<string, unknown>,
  unsubscribeUrl: string,
): string {
  return source.replace(/\{{{([^}]+)}}}/g, (match, expr: string) => {
    const trimmed = expr.trim();

    // Built-in: RESEND_UNSUBSCRIBE_URL
    if (trimmed === RESEND_UNSUB_VAR) {
      return unsubscribeUrl;
    }

    // contact.key[|fallback]
    const pipeIdx = trimmed.indexOf("|");
    const key = pipeIdx >= 0 ? trimmed.slice(0, pipeIdx).trim() : trimmed;
    const fallback = pipeIdx >= 0 ? trimmed.slice(pipeIdx + 1).trim() : match;

    if (key.startsWith("contact.")) {
      const field = key.slice("contact.".length);
      const value = resolveContactField(contact, field);
      return value !== undefined && value !== null ? String(value) : fallback;
    }

    // Attempt a top-level key lookup (simple variables).
    const topValue = contact[key];
    return topValue !== undefined && topValue !== null
      ? String(topValue)
      : fallback;
  });
}

function resolveContactField(
  contact: Record<string, unknown>,
  field: string,
): unknown {
  // Support camelCase or snake_case field names.
  const camel = snakeToCamel(field);
  return contact[field] ?? contact[camel];
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}
