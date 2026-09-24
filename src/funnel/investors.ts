/**
 * Deterministic, regex-only investor-name extraction from a headline/excerpt — the same discipline
 * as parseAmount/parseRound in extract.ts (no LLM, every hit traceable to a literal trigger
 * phrase). Built specifically to support the domain-identity verifier (domain-verify.ts): an
 * investor name is one of the few facts in a funding headline that an UNRELATED, same-named
 * incumbent company is very unlikely to also happen to mention on its own website.
 *
 * Deliberately conservative: only fires on an explicit trigger phrase ("led by", "backed by",
 * "from", "with participation from", "joined by", "co-led by"), and only captures a short run of
 * capitalized tokens immediately after it — never a fuzzy/heuristic "looks like a name" guess.
 * Under-extraction (missing a real investor name) is the safe failure mode here, not
 * over-extraction.
 */

const TRIGGER = /\b(?:led by|backed by|from|with participation from|joined by|co-led by)\s+/gi;

/** Generic words that can follow a trigger phrase but are never investor names on their own. */
const GENERIC_AFTER_TRIGGER = new Set([
  "the", "a", "an", "investors", "investor", "vcs", "vc", "others", "more", "existing", "new", "several", "multiple", "various", "undisclosed", "its", "his", "her", "their",
]);

/** Splits a captured run like "Lightspeed, Redpoint and Sequoia" into individual candidate names. */
function splitInvestorList(raw: string): string[] {
  return raw
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((s) => s.trim().replace(/[.,;:]+$/, ""))
    .filter((s) => s.length >= 2 && s.length <= 40)
    .filter((s) => /^[A-Z0-9]/.test(s))
    .filter((s) => !GENERIC_AFTER_TRIGGER.has(s.toLowerCase()));
}

/** Extracts investor-name candidates from free text (headline + snippet). Returns a deduplicated
 * list, original casing preserved (normalization for comparison happens at the call site). */
export function parseInvestors(text: string): string[] {
  const out = new Set<string>();
  TRIGGER.lastIndex = 0;
  for (let m = TRIGGER.exec(text); m; m = TRIGGER.exec(text)) {
    // Capture up to ~6 words of capitalized/connector tokens right after the trigger, stopping at
    // sentence punctuation or a lowercase word that isn't a list connector.
    const rest = text.slice(m.index + m[0].length);
    const run = /^((?:[A-Z][\w&.'-]*|and|&|,)(?:\s+(?:[A-Z][\w&.'-]*|and|&|,)){0,5})/.exec(rest);
    if (!run) continue;
    for (const name of splitInvestorList(run[1] as string)) out.add(name);
  }
  return [...out];
}

/** Normalizes an investor name for comparison against page text: lowercase, strip punctuation,
 * collapse whitespace — same normalization discipline used elsewhere in this codebase
 * (funnel/text.ts's own compact-key helpers), never fuzzy/similarity-based. */
export function normalizeInvestorName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
