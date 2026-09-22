/** Patterns for credentials that must never reach a log, even if a value slips into a message. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API keys
  /sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, // Supabase new-style keys
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs (Supabase legacy keys)
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
];

export type Redactor = (text: string) => string;

/**
 * Build a redactor that removes (a) the exact secret values it was given and
 * (b) anything shaped like a known credential.
 */
export function createRedactor(secrets: Iterable<string | undefined> = []): Redactor {
  const literals = [...secrets].filter((s): s is string => typeof s === "string" && s.length >= 8);
  return (text) => {
    let out = text;
    for (const s of literals) out = out.split(s).join("[REDACTED]");
    for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
    return out;
  };
}

export const noRedaction: Redactor = (t) => t;
