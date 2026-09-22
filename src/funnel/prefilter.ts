import type { RawLead } from "../schema.ts";
import { nameKey } from "./text.ts";

/** Companies that are plainly not "emerging". Deliberately short: ranking, not this list, handles the gray zone. */
const KNOWN_LARGE = new Set(
  [
    "google", "alphabet", "microsoft", "apple", "amazon", "meta", "facebook", "nvidia", "tesla", "samsung", "intel", "ibm", "oracle", "salesforce", "adobe",
    "uber", "airbnb", "netflix", "spotify", "paypal", "shopify", "cisco", "amd", "qualcomm", "sap", "siemens", "bosch", "toyota", "ford", "bmw", "volkswagen",
    "disney", "walmart", "jpmorgan", "visa", "mastercard", "nokia", "ericsson", "openai", "anthropic", "xai", "deepmind", "spacex", "stripe", "bloomberg",
  ].map((n) => nameKey(n)),
);

const FUND_WORDS = /\b(capital|ventures?|vc|partners|fund|funds|holdings|investments?|bank|equity|trust|reit|acquisition corp|asset management|advisors|advisers)\b/i;
/** Names that are programs or organizations rather than companies ("MedTech Innovator", "Constructor Start Cohort"). */
const PROGRAM_NAME = /\b(accelerator|incubator|innovators?|programme?|cohort|hackathon|fellowship|venture studio|demo day|challenge|competition|summit|conference)\b/i;
/** The headline itself says a FUND is being raised/launched ("closes maiden fund", "launch a Venture Capital Fund"). */
const FUND_IN_HEADLINE = /\b(?:closes?|raises?|launch(?:es)?|unveils?|announces?|secures?|debuts?)\b[^.]{0,40}\b(?:(?:maiden|first|second|new|its|a|an|the|\$?\d[\d.,]*\s?(?:m|million|b|billion)?|\w+)\s+){0,4}(?:fund|funds|vehicle)\b/i;

/**
 * Deterministic prefilter for a single lead. Returns a reason code when the lead should not enter the funnel, else null.
 * Reasons are recorded in the lead ledger, so every drop is auditable.
 */
export function prefilterLead(lead: RawLead): string | null {
  const key = nameKey(lead.name);
  if (KNOWN_LARGE.has(key)) return "known_large_company";
  const ex = lead.extracted;
  if ((ex?.event_type === "funding" || ex?.event_type === "product_launch") && (FUND_WORDS.test(lead.name) || (lead.headline && FUND_IN_HEADLINE.test(lead.headline)))) return "fund_or_investor_raise";
  if (PROGRAM_NAME.test(lead.name)) return "program_not_company";
  if (ex?.mature_signals.includes("public_company") || ex?.mature_signals.includes("ipo")) return "public_company";
  if (ex?.mature_signals.includes("late_round")) return "late_round";
  return null;
}
