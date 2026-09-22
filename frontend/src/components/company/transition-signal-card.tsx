import type { SignalViewModel } from "@/lib/derive/signal-view-model";
import { formatDate } from "@/lib/derive/recency";
import { SignalCardShell } from "./signal-card-shell";

/**
 * A confirmed CHANGE over time — "absent, then present, confirmed," never a guess. When the
 * view-model layer was able to recover a real progression (`vm.progression`, built ONLY from real
 * observation rows — see signal-view-model.ts: buildProgression), it renders as a compact inline
 * sequence ("Confirmed absent Sep 22 → First observed Sep 29 → Confirmed Oct 6"), which is what
 * makes "this was actually confirmed, not a single reading" visible without the user needing to
 * know what "confirmation" means in Scout's architecture. A signal with no recoverable progression
 * (e.g. a hiring/GitHub velocity signal, or sparse data) simply omits this — the numeric from/to
 * evidence in `SignalEvidence` already covers that case.
 */
export function TransitionSignalCard({ vm }: { vm: SignalViewModel }) {
  return (
    <SignalCardShell
      vm={vm}
      afterExplanation={
        vm.progression.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-faint">
            {vm.progression.map((step, i) => (
              <span key={`${step.label}-${step.date}`} className="inline-flex items-center gap-1.5">
                {i > 0 ? (
                  <span aria-hidden className="text-ink-faint">
                    →
                  </span>
                ) : null}
                <span>
                  {step.label} <span className="tabular">{formatDate(step.date)}</span>
                </span>
              </span>
            ))}
          </div>
        ) : null
      }
    />
  );
}
