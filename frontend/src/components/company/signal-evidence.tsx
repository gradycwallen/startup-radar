import type { EvidenceItem, SourceLink } from "@/lib/derive/signal-view-model";

/** Expandable evidence for one signal — a native `<details>` disclosure, the exact same
 * zero-JS interaction pattern `EvidenceTimeline`'s "N more sources" already uses, so this
 * introduces no new interaction vocabulary. Renders nothing at all when there's genuinely nothing
 * to show (never an empty disclosure). Only ever shows the small, normalized fields the view-model
 * layer already decided are safe — never raw metadata, ids, or internal terms. */
export function SignalEvidence({ evidence, sourceLinks }: { evidence: EvidenceItem[]; sourceLinks: SourceLink[] }) {
  if (evidence.length === 0 && sourceLinks.length === 0) return null;

  return (
    <details className="group mt-2.5">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-faint hover:text-ink-muted [&::-webkit-details-marker]:hidden">
        <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 transition-transform group-open:rotate-90">
          <path d="M4 2.5L8 6L4 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        View evidence
      </summary>
      <div className="mt-2 space-y-1.5 border-l border-line/60 pl-4">
        {evidence.map((item) => (
          <div key={item.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-xs">
            <span className="text-ink-faint">{item.label}</span>
            <span className="tabular text-ink-muted">{item.value}</span>
          </div>
        ))}
        {sourceLinks.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
            {sourceLinks.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                {link.label}
                <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3">
                  <path d="M3.5 8.5L8.5 3.5M8.5 3.5H4.5M8.5 3.5V7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
