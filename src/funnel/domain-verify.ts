import type { Entity } from "./entities.ts";
import { normalizeInvestorName, parseInvestors } from "./investors.ts";

/**
 * The stronger domain-identity verifier (V2-1 domain-resolution experiment, 2026-09-23 — see root
 * CLAUDE.md's research note). Answers a narrower question than the reverted first attempt:
 *
 *   "Is there independent evidence that THIS candidate page belongs to the SAME company described
 *   in the discovery evidence?" — never just "does the company name appear on this page?"
 *
 * A live precision audit of the first attempt (name + reachable + name-on-page) found real
 * failures: an unrelated, already-established company sharing the SAME name as a newly-funded
 * startup (Ande -> the real ANDE Rapid-DNA company; Travix -> the real Travix International travel
 * agency) will, almost by definition, have its own name all over its own homepage. That check
 * alone can never distinguish "same company" from "same name, different company."
 *
 * INDEPENDENCE HARDENING (2026-09-23, second pass): a live audit of this module's own only real
 * historical acceptance (kWh Coffee -> kwhcoffee.com) found the "independent" evidence wasn't
 * fully independent after all — "kwh coffee" (a phrase2 hit) is just the company's own name, and
 * "york" (a location hit) only appeared in the discovery evidence because the investor was named
 * "York Angels", not because of any genuine geography fact. Two fixes follow directly from that:
 *  1. The distinctive-phrase extractor now excludes the company's own name tokens entirely — a
 *     phrase built partly or wholly from the company's name contributes ZERO verification weight,
 *     even if none of its words are on the generic-vocabulary denylist.
 *  2. Location extraction runs against discovery-evidence text with investor names, program names,
 *     and the company's own name stripped out first — a location word is only ever independent
 *     evidence when it appears somewhere OTHER than inside one of those spans.
 * A third, more general fix: every accepted signal now records which literal tokens it consumed,
 * and a signal whose tokens overlap an already-counted signal's tokens is DISCARDED, not
 * double-counted — this is what actually enforces "two categories from the same underlying phrase
 * satisfy the two-moderate rule only once," rather than relying on category-name distinctness alone.
 * Round-stage and location were also reviewed for how much they can really tell us apart from a
 * same-named, unrelated company; both are downgraded from MODERATE to WEAK (logged for debugging,
 * never counted) rather than patched further — a same-named company at the same common funding
 * stage, or in the same city, is not unlikely, so neither is safe to treat as real corroboration on
 * its own. This is a deliberate precision-over-recall tightening, not a bug.
 *
 * This module never touches the network and never decides "guess this domain" — it only scores
 * evidence already in hand (the entity's own extracted funding facts) against page text the caller
 * already fetched. Deterministic, regex/keyword only — no LLM, no fuzzy/semantic matching (a
 * distinctive phrase must match VERBATIM, not "similarly").
 */

export type StrongCategory = "investor" | "amount" | "phrase3";
/** MODERATE no longer includes "round" or "location" — see this module's own doc comment for why
 * both were downgraded to WEAK. Two distinct MODERATE categories today means phrase2 AND program;
 * this is a deliberately narrow bar, not an oversight. */
export type ModerateCategory = "phrase2" | "program";
export type WeakCategory = "round" | "location";
export type ContradictionCategory = "scale" | "ownership";

export interface SignalHit {
  category: StrongCategory | ModerateCategory | WeakCategory;
  detail: string;
  /** The literal normalized token(s) this hit's evidence consumed — e.g. an investor name's own
   * words, or a matched phrase's own words. Used ONLY to detect when two different-looking hits
   * actually come from the same underlying fact (see `dedupeByTokenOverlap`), never shown to a
   * human as-is. */
  tokens: string[];
}
export interface ContradictionHit {
  category: ContradictionCategory;
  detail: string;
}

export interface VerificationInput {
  entity: Pick<Entity, "name" | "round" | "amount_usd" | "evidence" | "leads">;
  /** Already-fetched, already-capped page text (e.g. HomepageCheck.text) — this module fetches nothing. */
  pageText: string;
}

export interface VerificationResult {
  accepted: boolean;
  strong: SignalHit[];
  moderate: SignalHit[];
  /** Logged for transparency/debugging only — NEVER contributes to acceptance (see this module's
   * own doc comment on why round/location were downgraded here). */
  weak: SignalHit[];
  /** A hit that would otherwise have counted, but was discarded because it shares a literal token
   * with an already-counted hit from a DIFFERENT category — i.e. two categories that turned out to
   * describe the same underlying fact, not two independent facts. Shown for audit transparency. */
  discarded: SignalHit[];
  contradictions: ContradictionHit[];
  reason: string;
}

// ---- text normalization --------------------------------------------------------------------------------------------

/** Lowercase, punctuation-stripped, whitespace-collapsed — keeps word boundaries (unlike
 * funnel.ts's own `compact()`, which strips spaces too), because phrase/round/location matching
 * needs boundaries but exact-token matching (investor names, amounts) does not. */
function normalizeSpaced(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Fully compacted (no spaces at all) — for exact substring checks where word boundaries don't matter. */
function compactNoSpaces(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The company's own name, tokenized the same way phrase/location text is — used to strip the
 * company's own name out of evidence wherever it could otherwise leak in as "independent" corroboration. */
function nameTokensOf(name: string): Set<string> {
  return new Set(normalizeSpaced(name).split(" ").filter((w) => w.length >= 2));
}

// ---- discovery context text (what we compare the page against) ------------------------------------------------------

/** All the free text the discovery pipeline already extracted for this entity — every evidence
 * headline plus every lead's snippet. No new fetch, no new field: this is exactly what's already
 * on `Entity`/`RawLead` (see entities.ts/extract.ts). */
function discoveryContextText(entity: VerificationInput["entity"]): string {
  const titles = entity.evidence.map((e) => e.title ?? "").filter(Boolean);
  const snippets = entity.leads.map((l) => l.snippet ?? "").filter(Boolean);
  return [...titles, ...snippets].join(". ");
}

/** Removes every occurrence of each given span (case-insensitive, whole span as written) from
 * text, replacing it with a single space. Used to strip investor names / program names / the
 * company's own name out of context before location extraction — see this module's own doc
 * comment on the "York Angels" -> "York" leak this specifically fixes. */
function stripSpans(text: string, spans: readonly string[]): string {
  let out = text;
  for (const span of spans) {
    const trimmed = span.trim();
    if (trimmed.length < 2) continue;
    out = out.replace(new RegExp(escapeRegExp(trimmed), "gi"), " ");
  }
  return out;
}

// ---- amount matching (STRONG) ------------------------------------------------------------------------------------

/** Textual forms an amount like $52,000,000 plausibly appears as on a real page: "$52M", "$52
 * million", "USD 52 million", "52 million dollars". Handles one decimal place (e.g. $7.7M) since
 * that's common in real funding headlines. Amounts under $10k are not attempted — too likely to
 * collide with an unrelated number on the page. */
function amountPatterns(usd: number): RegExp[] {
  if (usd < 10_000) return [];
  const millions = usd / 1_000_000;
  if (millions < 0.01) return [];
  const m = Math.round(millions * 10) / 10; // one decimal place, matching how these are normally reported
  const mStr = Number.isInteger(m) ? String(m) : m.toFixed(1);
  const escaped = mStr.replace(".", "\\.");
  return [
    new RegExp(`\\$\\s?${escaped}\\s?m(illion)?\\b`, "i"),
    new RegExp(`\\$\\s?${escaped}\\s?mm\\b`, "i"),
    new RegExp(`usd\\s?${escaped}\\s?million\\b`, "i"),
    new RegExp(`${escaped}\\s?million\\s?(?:dollars|usd)\\b`, "i"),
    new RegExp(`€\\s?${escaped}\\s?m(illion)?\\b`, "i"),
    new RegExp(`£\\s?${escaped}\\s?m(illion)?\\b`, "i"),
  ];
}

// ---- distinctive phrase matching (STRONG at 3+ words, MODERATE at 2) -----------------------------------------------

/** Generic vocabulary that can NEVER be part of a "distinctive" phrase — matches the codebase's
 * own WEAK-evidence list (funding/industry buzzwords) plus ordinary stopwords. Deliberately long
 * and conservative: a phrase surviving this filter should be genuinely unusual. */
const GENERIC_PHRASE_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "from", "to", "of", "in", "on", "at", "is", "are", "was", "were", "be", "by",
  "ai", "software", "platform", "security", "fintech", "healthcare", "health", "saas", "startup", "startups", "company", "companies",
  "technology", "tech", "solution", "solutions", "app", "apps", "service", "services", "product", "products", "data", "cloud",
  "digital", "system", "systems", "new", "launch", "launches", "launched", "raises", "raised", "raising", "funding", "round",
  "seed", "series", "million", "billion", "dollars", "usd", "led", "backed", "based", "emerges", "emerged", "stealth", "today",
  "world", "global", "next", "first", "leading", "innovative", "announced", "announces", "announcing", "its", "their", "this",
  "that", "has", "have", "will", "more", "most", "best", "top", "one", "two", "three", "team", "business", "market", "industry",
]);

/** Sliding-window phrase extraction, 2 and 3 consecutive words, every word non-generic, >=3 chars,
 * and NOT one of the company's own name tokens (`excludeTokens`) — a phrase built from the
 * company's own name is not independent evidence of identity, no matter how "distinctive" it
 * otherwise looks (see this module's own doc comment: this is the direct fix for the "kwh coffee"
 * leak). Returns normalized (space-joined, lowercase) phrases — never fuzzy, exact substring match
 * required at the call site. */
function distinctivePhrases(text: string, wordCount: 2 | 3, excludeTokens: ReadonlySet<string>): string[] {
  const words = normalizeSpaced(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + wordCount <= words.length; i++) {
    const window = words.slice(i, i + wordCount);
    if (window.some((w) => w.length < 3 || GENERIC_PHRASE_WORDS.has(w) || excludeTokens.has(w) || /^\d+$/.test(w))) continue;
    out.add(window.join(" "));
  }
  return [...out];
}

// ---- location matching (WEAK — see this module's own doc comment) ---------------------------------------------------

/** A small, deliberately short gazetteer — not an attempt at exhaustive geocoding, just the
 * pattern already established in funnel/extract.ts's own LEADING_DESCRIPTORS place-name list
 * (city/country words that already show up stripped from company-name subjects). Extended with a
 * few more common startup-hub cities/countries. */
const LOCATION_WORDS = new Set([
  "london", "berlin", "paris", "stockholm", "helsinki", "tallinn", "amsterdam", "munich", "dublin", "madrid", "barcelona",
  "lisbon", "vienna", "zurich", "geneva", "copenhagen", "oslo", "warsaw", "prague", "brussels", "leuven", "cairo", "toronto",
  "vancouver", "sydney", "melbourne", "singapore", "tokyo", "bangalore", "mumbai", "delhi", "york", "boston", "austin", "seattle",
  "chicago", "miami", "denver", "atlanta", "germany", "france", "sweden", "finland", "estonia", "netherlands", "ireland",
  "spain", "portugal", "austria", "switzerland", "denmark", "norway", "poland", "belgium", "egypt", "canada", "australia",
  "india", "japan", "uk", "britain", "british", "german", "french", "swedish", "finnish", "estonian", "dutch", "irish",
  "spanish", "portuguese", "austrian", "swiss", "danish", "norwegian", "polish", "belgian", "egyptian", "canadian", "indian",
]);

function locationWords(text: string): string[] {
  const words = normalizeSpaced(text).split(" ");
  return [...new Set(words.filter((w) => LOCATION_WORDS.has(w)))];
}

// ---- contradiction detection ------------------------------------------------------------------------------------

/** Explicit large-scale-employer language — a specific, deterministic signal, never "the company
 * is old" alone (per the design brief: age is not an unconditional reject). */
const SCALE_CONTRADICTION = /\b(\d{3,}\+?\s*(?:employees|staff|people)|fortune\s?500|thousands of (?:employees|customers|users) worldwide|publicly traded|nasdaq|nyse)\b/i;

/** "part of the X Group/Company", "a subsidiary of X", "owned by X" — an explicit, named parent
 * relationship. Only a contradiction when the named parent has no counterpart anywhere in the
 * entity's own evidence (checked by the caller, since this function only detects the pattern). */
const OWNERSHIP_PATTERN = /\b(?:is\s+)?(?:a\s+)?(?:part of|subsidiary of|owned by|acquired by|member of)\s+(?:the\s+)?([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/;

function detectContradictions(entity: VerificationInput["entity"], pageText: string): ContradictionHit[] {
  const out: ContradictionHit[] = [];
  const scale = SCALE_CONTRADICTION.exec(pageText);
  if (scale) out.push({ category: "scale", detail: `page states "${scale[0]}"` });

  const ownership = OWNERSHIP_PATTERN.exec(pageText);
  if (ownership) {
    const parent = (ownership[1] as string).trim();
    const parentKey = normalizeInvestorName(parent);
    const entityKey = normalizeInvestorName(entity.name);
    // Only a contradiction if the named parent is NOT just the company's own name restated
    // ("part of the Acme family") and doesn't already appear anywhere in the discovery evidence
    // (e.g. an accelerator program name legitimately described as a "member of Techstars").
    const context = normalizeSpaced(discoveryContextText(entity));
    if (parentKey !== entityKey && parentKey.length >= 4 && !context.includes(parentKey)) {
      out.push({ category: "ownership", detail: `page states it is part of/owned by "${parent}", not mentioned anywhere in discovery evidence` });
    }
  }
  return out;
}

// ---- token-overlap independence guard --------------------------------------------------------------------------------

/** Two hits are "the same underlying fact" if they share ANY literal token. Keeps the FIRST hit
 * encountered for a given token; every later hit that touches an already-used token is discarded,
 * regardless of whether its `category` string differs — category-name distinctness alone is NOT
 * enough to prove two hits are independent (see this module's own doc comment). */
function dedupeByTokenOverlap(hits: readonly SignalHit[]): { kept: SignalHit[]; discarded: SignalHit[] } {
  const kept: SignalHit[] = [];
  const discarded: SignalHit[] = [];
  const used = new Set<string>();
  for (const hit of hits) {
    const overlaps = hit.tokens.some((t) => used.has(t));
    if (overlaps) {
      discarded.push(hit);
    } else {
      kept.push(hit);
      for (const t of hit.tokens) used.add(t);
    }
  }
  return { kept, discarded };
}

// ---- main verifier --------------------------------------------------------------------------------------------------

const PROGRAM_NAMES = ["y combinator", "techstars", "500 startups", "500 global"];

export function verifyDomainIdentity(input: VerificationInput): VerificationResult {
  const { entity, pageText } = input;
  const pageSpaced = normalizeSpaced(pageText);
  const pageCompact = compactNoSpaces(pageText);
  const context = discoveryContextText(entity);
  const nameTokens = nameTokensOf(entity.name);
  const entityNameKey = normalizeSpaced(entity.name);

  const strongCandidates: SignalHit[] = [];
  const moderateCandidates: SignalHit[] = [];
  const weak: SignalHit[] = [];

  // STRONG: investor name — excluding a self-referential "investor" that's just the company's own
  // name restated (defensive; the trigger-phrase extractor almost never produces this, but zero
  // tolerance for name-as-evidence applies here too).
  const investors = parseInvestors(context).filter((inv) => normalizeSpaced(inv) !== entityNameKey);
  for (const investor of investors) {
    const key = normalizeInvestorName(investor);
    if (key.length >= 3 && pageCompact.includes(key.replace(/\s/g, ""))) {
      strongCandidates.push({ category: "investor", detail: `investor "${investor}" found on page`, tokens: key.split(" ").filter(Boolean) });
    }
  }

  // STRONG: funding amount
  if (entity.amount_usd !== null) {
    for (const pattern of amountPatterns(entity.amount_usd)) {
      if (pattern.test(pageText)) {
        strongCandidates.push({
          category: "amount",
          detail: `amount matching $${(entity.amount_usd / 1_000_000).toFixed(1)}M found on page (${pattern.source})`,
          tokens: ["__amount__"], // a numeric fact never shares tokens with a word-based hit
        });
        break; // one confirmed amount match is enough — don't multiply-count pattern variants of the SAME fact
      }
    }
  }

  // STRONG (3-word) / MODERATE (2-word) distinctive phrase — company-name tokens excluded from BOTH.
  const phrases3 = distinctivePhrases(context, 3, nameTokens);
  const phrase3Hit = phrases3.find((p) => pageSpaced.includes(p));
  if (phrase3Hit) strongCandidates.push({ category: "phrase3", detail: `distinctive phrase "${phrase3Hit}" found on page`, tokens: phrase3Hit.split(" ") });

  if (!phrase3Hit) {
    const phrases2 = distinctivePhrases(context, 2, nameTokens);
    const phrase2Hit = phrases2.find((p) => pageSpaced.includes(p));
    if (phrase2Hit) moderateCandidates.push({ category: "phrase2", detail: `distinctive phrase "${phrase2Hit}" found on page`, tokens: phrase2Hit.split(" ") });
  }

  // WEAK: round-stage mention — downgraded from MODERATE (see this module's own doc comment): a
  // same-named, unrelated company at the same common funding stage is not unlikely, so this alone
  // is never safe corroboration. Still logged for debugging.
  if (entity.round) {
    const roundWords: Record<string, string[]> = {
      pre_seed: ["pre-seed", "pre seed"], seed: ["seed round", "seed funding"], series_a: ["series a"], series_b: ["series b"],
      pre_series_a: ["pre-series a"], angel: ["angel round"], bridge: ["bridge round"], grant: ["grant"],
    };
    const words = roundWords[entity.round] ?? [];
    const hit = words.find((w) => pageSpaced.includes(w));
    if (hit) weak.push({ category: "round", detail: `round stage "${entity.round}" mentioned on page`, tokens: hit.split(/[\s-]+/) });
  }

  // WEAK: location — downgraded from MODERATE, AND its extraction now strips investor names,
  // program names, and the company's own name out of the discovery-evidence text FIRST, so a
  // location word that only appeared because of the investor's NAME (e.g. "York Angels" ->
  // "York") is never attributed to genuine geography context. Still logged for debugging.
  const sanitizedContext = stripSpans(context, [...investors, ...PROGRAM_NAMES, entity.name]);
  const contextLocations = locationWords(sanitizedContext);
  const pageLocations = new Set(locationWords(pageText));
  const locationHit = contextLocations.find((loc) => pageLocations.has(loc));
  if (locationHit) weak.push({ category: "location", detail: `location "${locationHit}" mentioned in both discovery evidence and page (investor/program/company-name spans excluded)`, tokens: [locationHit] });

  // MODERATE: named accelerator/program (only meaningful for structured/directory entities, but
  // checked generically — a specific named program, e.g. "Y Combinator"/"Techstars", is far more
  // specific than the generic word "accelerator").
  const contextHasProgram = PROGRAM_NAMES.filter((p) => normalizeSpaced(context).includes(p));
  const programHit = contextHasProgram.find((p) => pageSpaced.includes(p));
  if (programHit) moderateCandidates.push({ category: "program", detail: `named program "${programHit}" mentioned on page`, tokens: programHit.split(" ") });

  const contradictions = detectContradictions(entity, pageText);

  // Independence guard: a hit that shares a literal token with an already-counted hit (from
  // EITHER tier) is the same underlying fact wearing a different category label — discard it
  // rather than let it inflate the distinct-category count. Strong candidates are checked first
  // (their own priority order is preserved), so a strong hit can "claim" tokens a later moderate
  // hit would otherwise have used — correct, since a stronger fact subsumes a weaker restatement
  // of the same evidence.
  const { kept, discarded } = dedupeByTokenOverlap([...strongCandidates, ...moderateCandidates]);
  const strongCategories = new Set<StrongCategory>(["investor", "amount", "phrase3"]);
  const strong = kept.filter((h) => strongCategories.has(h.category as StrongCategory));
  const moderate = kept.filter((h) => !strongCategories.has(h.category as StrongCategory));

  const distinctStrongCategories = new Set(strong.map((s) => s.category));
  const distinctModerateCategories = new Set(moderate.map((s) => s.category));

  const hasStrong = distinctStrongCategories.size >= 1;
  const hasTwoModerate = distinctModerateCategories.size >= 2;
  const noContradictions = contradictions.length === 0;

  const accepted = (hasStrong || hasTwoModerate) && noContradictions;

  const discardedNote = discarded.length ? ` (${discarded.length} discarded as non-independent: ${discarded.map((d) => d.category).join(", ")})` : "";
  let reason: string;
  if (!noContradictions) reason = `rejected: contradiction(s) found — ${contradictions.map((c) => c.detail).join("; ")}`;
  else if (hasStrong) reason = `accepted: strong signal(s) — ${[...distinctStrongCategories].join(", ")}${discardedNote}`;
  else if (hasTwoModerate) reason = `accepted: ${distinctModerateCategories.size} independent moderate signals — ${[...distinctModerateCategories].join(", ")}${discardedNote}`;
  else reason = `rejected: insufficient independent evidence (${strong.length} strong, ${distinctModerateCategories.size} distinct moderate categories)${discardedNote}`;

  return { accepted, strong, moderate, weak, discarded, contradictions, reason };
}
