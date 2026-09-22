import { normalizeDomain } from "../domain.ts";
import type { Extracted, RawLead } from "../schema.ts";
import type { SourceItem } from "../sources/types.ts";
import { domainInName } from "./text.ts";

/**
 * Deterministic extraction (no LLM): turn a SourceItem into zero or one raw lead by recognizing announcement patterns in
 * headlines (raises / stealth / launches / accelerator) and reading structured directory rows directly. Everything that
 * is inferred is recorded in `extracted.patterns`, so any lead can be audited back to the rule that produced it.
 */

export interface ExtractionResult {
  leads: RawLead[];
  /** Why the item produced no lead (item-level drop), or null. */
  dropped: string | null;
}

// ---- patterns ------------------------------------------------------------------------------------------------------

const ROUNDUP =
  /(round-?up|\bweekly\b|this week|newsletter|podcast|episode|digest|in review|\btop \d+|\b\d+ (?:startups|companies|ways|things|founders|investors|takeaways)\b|what we|list of|funding (?:news|report)|save up to|\btickets?\b|\bdisrupt\b|to watch|sponsored|webinar|\bevent\b:|\bwatch:|\bopinion\b)/i;
const NOT_AN_ANNOUNCEMENT = /^(how|why|what|where|who|when|is|are|can|will|should|do|does|did)\b|\?\s*$/i;
const M_AND_A = /\b(acquires?|acquired|acquisition of|to acquire|buys|bought|merges? with|merger|takeover|snaps up)\b/i;

const STEALTH = /\b(emerges?|emerged|exits?|exited|comes? out of|came out of|steps? out of|launches? out of|leaves|unveiled|unveils?)\b(?=[^.]{0,60}\bstealth\b)/i;
const FUNDING_STRONG = /\b(raises?|raised|raising|closes?|closed|secures?|secured|completes?|completed|bags|nabs)\b/i;
const FUNDING_WEAK = /\b(lands?|landed|gets|scores|nets|snags|banks|wins|receives?|obtains?|unlocks?|pulls in|picks up)\b/i;
const FUNDING_EVIDENCE = /([$€£]\s?\d|\bUS\$|\d\s?(?:million|billion|m|bn)\b|\bmulti-?million\b|\bfunding\b|\bfinancing\b|\binvestment\b|\bseed\b|\bpre-?seed\b|\bseries [a-h]\b|\bround\b|\bcapital\b)/i;
const ACCEL = /\b(joins?|joined|selected|accepted|admitted|named|welcomes?)\b(?=[^.]{0,80}\b(accelerator|cohort|incubator|program|programme|batch|class|demo day|techstars|y combinator|yc)\b)/i;
const LAUNCH_STRONG = /\b(launch(?:es|ed)?|unveils?|unveiled|debuts?|introduces?|introduced)\b/i;
const LAUNCH_WEAK = /\b(wants to|hopes to|aims to|is launching|is building|rolls? out|goes live|opens up)\b/i;

const ROUND_RE = /\b(pre[- ]?seed|seed|series\s+[a-h]\b|pre[- ]series\s+[ab]\b|angel|bridge|grant|convertible|venture debt|debt financing)/i;
const CURRENCY_USD: Record<string, number> = { USD: 1, "US$": 1, $: 1, EUR: 1.08, "€": 1.08, GBP: 1.27, "£": 1.27, CHF: 1.12, "A$": 0.65, "C$": 0.73 };
const UNIT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

// ---- amounts and rounds -----------------------------------------------------------------------------------------------

export interface ParsedAmount {
  usd: number | null;
  text: string | null;
  currency: string | null;
}

/** First funding amount in the text (valuations, revenue and bare small numbers are skipped). "multi-million" gives text but no number. */
export function parseAmount(text: string): ParsedAmount {
  const re = /(?:(US\$|USD|EUR|GBP|CHF|A\$|C\$)\s?|([$€£]))\s?(\d[\d,]*(?:\.\d+)?)\s?(billion|million|thousand|bn|mm|m|b|k)?(?![a-z])|(\d[\d,]*(?:\.\d+)?)\s?(billion|million|thousand)\s+(?:dollars|euros|pounds|usd|eur|gbp)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (/^\s*(valuation|valued|market cap|in revenue|arr\b|annual)/i.test(after) || /(valued at|valuation of|worth|revenue of|arr of)\s*$/i.test(before)) continue;
    const symbol = (m[1] ?? m[2] ?? "USD").toUpperCase() === "US$" ? "USD" : (m[1] ?? m[2] ?? "USD");
    const num = Number((m[3] ?? m[5] ?? "").replace(/,/g, ""));
    const unitKey = (m[4] ?? m[6] ?? "").toLowerCase();
    if (!Number.isFinite(num)) continue;
    const mult = UNIT[unitKey];
    if (mult === undefined && num < 100_000) continue; // "$200" is not a funding round
    const rate = CURRENCY_USD[symbol.toUpperCase()] ?? CURRENCY_USD[symbol] ?? 1;
    const currency = /€|EUR/i.test(symbol) ? "EUR" : /£|GBP/i.test(symbol) ? "GBP" : /CHF/i.test(symbol) ? "CHF" : "USD";
    return { usd: Math.round(num * (mult ?? 1) * rate), text: m[0].trim(), currency };
  }
  const multi = /\bmulti-?million(?:-(?:euro|dollar|pound))?\b/i.exec(text);
  return multi ? { usd: null, text: multi[0], currency: /euro/i.test(multi[0]) ? "EUR" : null } : { usd: null, text: null, currency: null };
}

export function parseRound(text: string): string | null {
  const m = ROUND_RE.exec(text);
  if (!m) return null;
  const r = m[1]!.toLowerCase().replace(/\s+/g, " ");
  if (/^pre[- ]?seed/.test(r)) return "pre_seed";
  if (r === "seed") return "seed";
  const series = /^series ([a-h])/.exec(r);
  if (series) return `series_${series[1]}`;
  if (/pre[- ]series/.test(r)) return "pre_series_a";
  if (r === "angel") return "angel";
  if (r === "bridge") return "bridge";
  if (r === "grant") return "grant";
  if (/debt/.test(r)) return "debt";
  return "convertible";
}

export const isLateRound = (round: string | null): boolean => !!round && /^series_[c-h]$/.test(round);

// ---- signals --------------------------------------------------------------------------------------------------------

export function youngSignals(text: string, eventType: string, round: string | null): string[] {
  const out: string[] = [];
  if (eventType === "stealth") out.push("stealth_exit");
  if (round && ["pre_seed", "seed", "series_a", "pre_series_a", "angel"].includes(round)) out.push("early_round");
  const founded = /\bfounded\s+(?:in\s+)?(?:early\s+|late\s+)?(20\d\d)\b/i.exec(text);
  if (founded && Number(founded[1]) >= 2021) out.push(`founded_${founded[1]}`);
  if (/\bspin[- ]?(?:out|off)s?\b|\bspun out\b/i.test(text)) out.push("spinout");
  if (/\bincubat/i.test(text)) out.push("incubated");
  if (/\b(?:first|debut|inaugural)\s+(?:product|release|launch|model)\b/i.test(text)) out.push("debut");
  if (eventType === "accelerator") out.push("accelerator_cohort");
  return out;
}

export function matureSignals(text: string, round: string | null): string[] {
  const out: string[] = [];
  if (isLateRound(round)) out.push("late_round");
  if (/\b(?:NASDAQ|NYSE|LSE|TSX|Euronext|OTC[A-Z]*)\s*[:\-]\s*[A-Z]{1,5}\b/.test(text)) out.push("public_company");
  if (/\bIPO\b|\bpublicly traded\b/i.test(text)) out.push("ipo");
  const founded = /\bfounded\s+(?:in\s+)?(19\d\d|20[01]\d)\b/i.exec(text);
  if (founded && Number(founded[1]) < 2018) out.push(`founded_${founded[1]}`);
  return out;
}

// ---- company name from a headline ----------------------------------------------------------------------------------------

const GENERIC_SUBJECTS = new Set([
  "startup", "startups", "company", "companies", "firm", "investors", "investor", "founders", "founder", "report", "exclusive", "this", "the", "a", "an",
  "why", "how", "what", "who", "here", "sources", "vc", "vcs", "funds", "fund", "europe", "uk", "us", "ai", "tech", "fintech", "saas", "new", "another",
  "one", "two", "three", "day", "week", "today", "sequoia", "andreessen", "a16z", "y combinator", "techstars", "openai", "anthropic",
]);

/** Words that describe a company rather than name it; stripped from the FRONT of a subject ("AI Startup Gaia Dynamics"). */
const LEADING_DESCRIPTORS = new Set([
  "ai", "startup", "startups", "company", "platform", "provider", "maker", "developer", "builder", "giant", "unicorn", "scaleup", "fintech", "healthtech",
  "edtech", "biotech", "cybersecurity", "security", "payments", "infrastructure", "software", "robotics", "climate", "data", "cloud", "crypto", "defense",
  "defence", "space", "energy", "mobility", "logistics", "marketplace", "network", "service", "services", "tool", "tools", "firm", "outfit", "venture", "new",
  "german", "french", "british", "swedish", "finnish", "danish", "dutch", "norwegian", "estonian", "indian", "israeli", "european", "us", "uk", "london",
  "berlin", "paris", "stockholm", "helsinki", "tallinn", "amsterdam", "munich", "early-stage", "stealthy",
]);
/** Words after which the real name follows ("DeepMind Offshoot Emulate" -> "Emulate"). */
const NAME_FOLLOWS = new Set(["offshoot", "spinout", "spinoff", "rival", "alum", "alumni", "founder", "founders", "cofounder", "backed", "startup", "company", "platform", "provider", "maker", "developer", "builder", "unicorn", "scaleup", "firm"]);
/** A subject ending in one of these describes a company ("Uzbek Startup") instead of naming it. */
const TRAILING_GENERIC = new Set(["startup", "startups", "company", "companies", "firm", "platform", "provider", "maker", "developer", "builder", "giant", "unicorn", "scaleup", "outfit", "venture"]);
const HYPHEN_MODIFIER = /-(backed|incubated|founded|based|led|funded|owned|focused|powered|native|driven|born|stage)$/i;

const bare = (t: string) => t.toLowerCase().replace(/[^a-z0-9.\-+&]/g, "");
// A token counts as part of a name if it starts with a capital/digit, has an inner capital, or is itself a domain ("Fin.com").
// A trailing sentence period ("page.") does not make a token name-like.
const nameLike = (t: string) => /^[A-Z0-9]/.test(t) || /[A-Z]/.test(t.slice(1)) || /^[a-z0-9-]+\.[a-z]{2,}$/i.test(t);

/** The company named by the headline's subject (the text before the event verb), or null when it is not a plausible name. */
export function cleanSubject(raw: string): string | null {
  let s = raw.replace(/^(exclusive|breaking|report|update|watch|sponsored|opinion)\s*[:\-–—]\s*/i, "").replace(/['’]s\s*$/i, "").trim().replace(/,?\s+(?:inc|llc|ltd|gmbh|corp|co)\.?$/i, "").trim();
  const comma = /^(.{2,40}?),\s+(?:a|an|the)\s/i.exec(s);
  if (comma) s = comma[1] as string;
  s = s.replace(/^["“'‘]|["”'’]$/g, "").replace(/[,:;–—-]+$/, "").trim();
  if (!s || s.length > 90) return null;

  // Two capitalized entities joined by "and"/"&" ("SparkLabs and Mirae Asset") are not one company name: ambiguous, so no lead.
  if (/\b[A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)?\s+(?:and|&)\s+[A-Z][\w.-]*/.test(s)) return null;
  let toks = s.split(/\s+/).filter((t) => !HYPHEN_MODIFIER.test(t));
  // "London's Metris Energy", "Belgium's NewSchool VC": a leading place possessive is not part of the name.
  if (toks.length >= 2 && /^[A-Z][\p{L}-]+['’]s$/u.test(toks[0] as string) && nameLike(toks[1] as string)) toks = toks.slice(1);
  toks = toks.map((t, i) => (i === toks.length - 1 ? t.replace(/[.,;:]+$/, "") : t));
  const last = toks.map((t) => NAME_FOLLOWS.has(bare(t))).lastIndexOf(true);
  if (last >= 0 && last < toks.length - 1) toks = toks.slice(last + 1);

  if (toks.length === 1) {
    const only = toks[0] as string;
    if (GENERIC_SUBJECTS.has(bare(only)) || /^\d+$/.test(only) || only.length > 40) return null;
    return only;
  }
  // Longest name-like suffix (stops at the first lowercase non-connector word from the right).
  let start = toks.length;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i] as string;
    const connector = i > 0 && i < toks.length - 1 && /^(of|de|van|von|and|&|the|la|el|del|di)$/i.test(t);
    if (nameLike(t) || connector) start = i;
    else break;
  }
  toks = toks.slice(start);
  while (toks.length > 1 && LEADING_DESCRIPTORS.has(bare(toks[0] as string))) toks.shift();
  if (toks.length === 0 || toks.length > 4) return null;
  if (TRAILING_GENERIC.has(bare(toks[toks.length - 1] as string))) return null;
  const name = toks.join(" ").replace(/^the\s+/i, "");
  const key = bare(name);
  if (!name || GENERIC_SUBJECTS.has(key) || /^\d+\s|^\d+$/.test(name) || /[$€£]/.test(name)) return null;
  if (toks.length > 1 && name === name.toLowerCase()) return null;
  return name.length <= 40 ? name : null;
}

// ---- headline extraction -------------------------------------------------------------------------------------------------

interface Hit {
  type: "stealth" | "funding" | "accelerator" | "product_launch";
  index: number;
  pattern: string;
}

function findEvent(title: string): Hit | null {
  const hasFundingEvidence = FUNDING_EVIDENCE.test(title);
  const stealth = STEALTH.exec(title);
  if (stealth) return { type: "stealth", index: stealth.index, pattern: "stealth_verb" };
  const strong = FUNDING_STRONG.exec(title);
  if (strong && hasFundingEvidence) return { type: "funding", index: strong.index, pattern: "funding_verb" };
  const accel = ACCEL.exec(title);
  if (accel) return { type: "accelerator", index: accel.index, pattern: "accelerator_verb" };
  const weak = FUNDING_WEAK.exec(title);
  if (weak && hasFundingEvidence && /[$€£]\s?\d|\bseed\b|\bseries [a-h]\b|\bfunding\b|\d\s?(?:million|m)\b/i.test(title)) return { type: "funding", index: weak.index, pattern: "funding_weak_verb" };
  const launch = LAUNCH_STRONG.exec(title) ?? LAUNCH_WEAK.exec(title);
  if (launch) {
    // "X launches with $21M" is a funding announcement, not just a product launch.
    const withMoney = /[$€£]\s?\d|\bseed\b|\bseries [a-h]\b|\d\s?(?:million|m)\b/i.test(title);
    return { type: withMoney ? "funding" : "product_launch", index: launch.index, pattern: withMoney ? "launch_with_funding" : "launch_verb" };
  }
  return null;
}

export interface HeadlineExtraction {
  company_name: string;
  event_type: Hit["type"];
  round: string | null;
  amount: ParsedAmount;
  young_signals: string[];
  mature_signals: string[];
  patterns: string[];
}

/** Extract a company + event from a headline (with the excerpt for round/amount/signals). Returns a drop reason when it cannot. */
export function extractHeadline(title: string, excerpt: string): HeadlineExtraction | { drop: string } {
  if (ROUNDUP.test(title)) return { drop: "roundup_or_digest" };
  if (NOT_AN_ANNOUNCEMENT.test(title.trim())) return { drop: "not_an_announcement" };
  const hit = findEvent(title);
  if (!hit) return { drop: M_AND_A.test(title) ? "m_and_a" : "no_event_pattern" };
  if (M_AND_A.test(title) && hit.type !== "stealth") return { drop: "m_and_a" };
  const name = cleanSubject(title.slice(0, hit.index));
  if (!name) return { drop: "no_company_subject" };
  const context = `${title}. ${excerpt.slice(0, 500)}`;
  const round = parseRound(title) ?? parseRound(excerpt.slice(0, 300));
  const amount = parseAmount(title).usd !== null || parseAmount(title).text ? parseAmount(title) : parseAmount(excerpt.slice(0, 300));
  const patterns = [hit.pattern];
  if (parseAmount(title).text) patterns.push("amount_in_title");
  if (parseRound(title)) patterns.push("round_in_title");
  return {
    company_name: name,
    event_type: hit.type,
    round,
    amount,
    young_signals: youngSignals(context, hit.type, round),
    mature_signals: matureSignals(context, round),
    patterns,
  };
}

// ---- item -> lead -------------------------------------------------------------------------------------------------------

const LANE_FOR_EVENT: Record<string, string> = { funding: "funding", stealth: "stealth", product_launch: "launches", accelerator: "accelerator", news: "news" };
export const laneForEvent = (eventType: string, fallback: string): string => LANE_FOR_EVENT[eventType] ?? fallback;

const datePart = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

export function extractLeads(item: SourceItem): ExtractionResult {
  if (item.structured) {
    const s = item.structured;
    const website = s.website ? normalizeDomain(s.website) : null;
    const extracted: Extracted = {
      item_id: item.item_id, company_name: s.company_name, name_from: "structured", event_type: "accelerator", round: null, amount_usd: null, amount_text: null,
      currency: null, young_signals: ["accelerator_cohort", ...(s.program ? [`program:${s.program}`] : [])], mature_signals: [], patterns: ["structured_directory"],
    };
    return {
      dropped: null,
      leads: [{
        provider: item.provider, lane: "accelerator", name: s.company_name, homepage_hint: website ? `https://${website}` : null, event_type_hint: "accelerator",
        source_url: item.url, source_name: item.source_name, event_date: datePart(item.published_at), headline: item.title, snippet: (s.description ?? item.excerpt).slice(0, 300) || null,
        source_retrieved: true, published_at: item.published_at, domain_candidates: website ? [website] : [], domain_trust: website ? "structured" : null, extracted,
      }],
    };
  }
  const got = extractHeadline(item.title, item.excerpt);
  if ("drop" in got) return { leads: [], dropped: got.drop };
  const nameDomain = domainInName(got.company_name);
  const candidates = [...(nameDomain ? [nameDomain] : []), ...item.outbound_domains.filter((d) => d !== nameDomain)];
  const extracted: Extracted = {
    item_id: item.item_id, company_name: got.company_name, name_from: "headline", event_type: got.event_type, round: got.round, amount_usd: got.amount.usd,
    amount_text: got.amount.text, currency: got.amount.currency, young_signals: got.young_signals, mature_signals: got.mature_signals, patterns: got.patterns,
  };
  return {
    dropped: null,
    leads: [{
      provider: item.provider, lane: laneForEvent(got.event_type, item.lane), name: got.company_name, homepage_hint: nameDomain ? `https://${nameDomain}` : null,
      event_type_hint: got.event_type, source_url: item.url, source_name: item.source_name, event_date: datePart(item.published_at), headline: item.title,
      snippet: item.excerpt.slice(0, 300) || null, source_retrieved: true, published_at: item.published_at, domain_candidates: candidates,
      domain_trust: nameDomain ? "name" : null, extracted,
    }],
  };
}
