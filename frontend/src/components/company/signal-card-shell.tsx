import type { ReactNode } from "react";
import clsx from "clsx";
import type { SignalViewModel } from "@/lib/derive/signal-view-model";
import { formatDate } from "@/lib/derive/recency";
import { FamilyBadge } from "./family-badge";
import { SignalEvidence } from "./signal-evidence";

/**
 * The shared chrome both `FirstLookSignalCard` and `TransitionSignalCard` render inside — family
 * badge, date, title, explanation, tier treatment, evidence. Kept as one internal shell so the two
 * kind-specific cards can never visually drift apart by accident; what actually differs between
 * them (the "First observed" tag vs. the transition progression) is passed in as slots, not
 * duplicated markup.
 *
 * Tier (design report §13/§9): a subtle LEFT BORDER weight/color difference only — no label, no
 * stars, no number. `null`/`"low"` tier both render a transparent rule (same 2px gutter, so
 * nothing shifts); only `"high"` gets the amber-tinted edge. This deliberately reuses the exact
 * visual language the "why it's on the radar" callout already established (border-accent/50)
 * elsewhere on this page. No box around the card itself — rows are separated by the parent's
 * `divide-y` hairline (signal-intelligence-section.tsx), not a bordered/rounded container.
 */
export function SignalCardShell({ vm, tag, afterExplanation }: { vm: SignalViewModel; tag?: ReactNode; afterExplanation?: ReactNode }) {
  return (
    <div className={clsx("py-5 pl-4 border-l-2", vm.tier === "high" ? "border-l-accent/50" : "border-l-transparent")}>
      <div className="flex flex-wrap items-center gap-2">
        <FamilyBadge label={vm.familyLabel} />
        <span className="text-xs text-ink-faint">{formatDate(vm.firedAt)}</span>
        {tag}
      </div>
      <p className="mt-1.5 font-medium text-ink">{vm.title}</p>
      <p className="mt-1 text-sm text-ink-muted">{vm.explanation}</p>
      {afterExplanation}
      <SignalEvidence evidence={vm.evidence} sourceLinks={vm.sourceLinks} />
    </div>
  );
}
