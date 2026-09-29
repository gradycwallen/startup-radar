import type { SignalViewModel } from "@/lib/derive/signal-view-model";
import { SignalCardShell } from "./signal-card-shell";

/**
 * A cold-start / level signal — "we saw this when tracking began," never "this recently
 * happened." The "First observed" tag sits right next to the date (not buried in prose) so a user
 * pattern-matches the distinction before reading a word — see the V2-3A design report §4/§7. The
 * view-model layer (signal-view-model.ts) already guarantees `vm.title`/`vm.explanation` never use
 * a verb of change for a first-look signal; this component's only job is to not undo that by
 * adding an icon or wording of its own that implies motion (no arrow, no "New!").
 */
export function FirstLookSignalCard({ vm }: { vm: SignalViewModel }) {
  return (
    <SignalCardShell
      vm={vm}
      tag={<span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">First observed</span>}
    />
  );
}
