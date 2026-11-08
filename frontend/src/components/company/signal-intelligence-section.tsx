import type { SignalIntelligence } from "@/lib/data/types";
import { buildCoverageLine, buildSignalViewModels, SIGNAL_EMPTY_STATE_COPY, type SignalViewModel } from "@/lib/derive/signal-view-model";
import { ActivityTimeline } from "./activity-timeline";
import { CoverageLine } from "./coverage-line";
import { FirstLookSignalCard } from "./first-look-signal-card";
import { TransitionSignalCard } from "./transition-signal-card";

/**
 * Signal Intelligence — Company Detail's new section (V2-3A). Deliberately placed BEFORE the
 * existing Discovery timeline (see the delivery report §2): signals describe the company's
 * CURRENT, ongoing state; discovery events are a backward-looking record of what was found. Kept
 * visually and conceptually separate from that timeline — no shared component, no unified list,
 * no borrowed "Momentum" language anywhere in this file or its children.
 *
 * Three distinct states, three distinct treatments (design report §6/§11 — approved as-is):
 *   A. zero signal_sources resolved  -> a small neutral note, no card list at all.
 *   B. sources resolved, zero fired  -> "Tracking started — no notable change detected yet."
 *   C. one or more signals fired     -> the real card list (grouped by family only when 2+ exist).
 */
export function SignalIntelligenceSection({ intelligence }: { intelligence: SignalIntelligence }) {
  if (intelligence.unavailable) return <section className="mt-14 max-w-3xl"><h2 className="text-2xl font-bold tracking-tight">Signal intelligence</h2><p className="mt-2 text-sm text-ink-muted">Signal history is temporarily unavailable. Please try again later.</p></section>;
  if (intelligence.sources.length === 0) {
    return (
      <section className="mt-14 max-w-3xl">
        <h2 className="text-2xl font-bold tracking-tight text-ink">Signal intelligence</h2>
        <p className="mt-1.5 text-sm text-ink-muted">{SIGNAL_EMPTY_STATE_COPY.noSources}</p>
      </section>
    );
  }

  const viewModels = buildSignalViewModels(intelligence);
  const coverageText = buildCoverageLine(intelligence);

  return (
    <section className="mt-14 max-w-3xl">
      <h2 className="text-2xl font-bold tracking-tight text-ink">Signal intelligence</h2>
      <p className="mt-1.5 text-sm text-ink-muted">Deterministic signals Startup Radar has derived from hiring, GitHub and website activity, never inferred, never scored.</p>
      <CoverageLine text={coverageText} />
      <ActivityTimeline observations={intelligence.observations} sources={intelligence.sources} />

      {viewModels.length === 0 ? (
        <p className="mt-5 text-sm text-ink-muted">{SIGNAL_EMPTY_STATE_COPY.noSignalsYet}</p>
      ) : (
        <div className="mt-6">
          <SignalCardList viewModels={viewModels} />
        </div>
      )}
    </section>
  );
}

function SignalCard({ vm }: { vm: SignalViewModel }) {
  return vm.kind === "first_look" ? <FirstLookSignalCard vm={vm} /> : <TransitionSignalCard vm={vm} />;
}

/** Groups by family ONLY when 2+ families are actually present (design report §8: "do not add
 * unnecessary group-heading chrome" for a single-family company). Family order follows each
 * family's most-recently-fired signal, so the reading order still roughly tracks recency —
 * `viewModels` is already sorted newest-first, and building groups by first-encountered family
 * preserves that. */
function SignalCardList({ viewModels }: { viewModels: SignalViewModel[] }) {
  const families = [...new Set(viewModels.map((v) => v.family))];
  if (families.length <= 1) {
    return (
      <div className="divide-y divide-line">
        {viewModels.map((vm) => (
          <SignalCard key={vm.id} vm={vm} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {families.map((family) => {
        const group = viewModels.filter((v) => v.family === family);
        return (
          <div key={family}>
            <h3 className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">{group[0]!.familyLabel}</h3>
            <div className="mt-2 divide-y divide-line">
              {group.map((vm) => (
                <SignalCard key={vm.id} vm={vm} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
