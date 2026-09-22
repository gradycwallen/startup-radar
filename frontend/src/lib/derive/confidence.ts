/**
 * Confidence tiers, derived transparently from the real `confidence` value Scout stored (never
 * fabricated). Thresholds echo the backend's own acceptance rule: 0.75 is Scout's minimum
 * confidence to accept a candidate at all (root CLAUDE.md §3/§7), so everything in this dataset is
 * already at least "Moderate" by construction — "Strong" marks the clearest, best-evidenced cases.
 */
export type ConfidenceTier = "strong" | "moderate" | "emerging";

export interface ConfidenceInfo {
  tier: ConfidenceTier;
  label: string;
  percent: number | null;
}

export function confidenceInfo(confidence: number | null): ConfidenceInfo {
  if (confidence === null) return { tier: "emerging", label: "Unrated", percent: null };
  const percent = Math.round(confidence * 100);
  if (confidence >= 0.9) return { tier: "strong", label: "Strong evidence", percent };
  if (confidence >= 0.75) return { tier: "moderate", label: "Moderate evidence", percent };
  return { tier: "emerging", label: "Emerging signal", percent };
}
