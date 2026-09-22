import type { DiscoveryEvent } from "@/lib/data/types";
import { groupEvents } from "@/lib/derive/group-events";
import { SignalBadge } from "./signal-badge";
import { formatDate } from "@/lib/derive/recency";
import { ConfidenceBadge } from "./confidence-badge";

export function EvidenceTimeline({ events }: { events: DiscoveryEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-ink-muted">No discovery events recorded for this company yet.</p>;
  }

  const groups = groupEvents(events);

  return (
    <ol className="relative space-y-6 border-l border-line pl-6">
      {groups.map((group) => {
        const { primary } = group;
        const otherSources = group.events.filter((e) => e.id !== primary.id);
        return (
          <li key={primary.id} className="relative">
            <span aria-hidden className="absolute -left-[29px] top-1 h-2.5 w-2.5 rounded-full border-2 border-canvas bg-accent" />
            <div className="flex flex-wrap items-center gap-2">
              <SignalBadge eventType={primary.eventType} />
              <span className="text-xs text-ink-faint">{formatDate(primary.eventDate) ?? formatDate(primary.observedAt)}</span>
            </div>
            {primary.headline ? <p className="mt-1.5 font-medium text-ink">{primary.headline}</p> : null}
            {primary.description ? <p className="mt-1 text-sm text-ink-muted">{primary.description}</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              <ConfidenceBadge confidence={primary.confidence} />
              {primary.sourceUrl ? (
                <a href={primary.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                  {primary.sourceName ?? "Source"}
                  <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3">
                    <path d="M3.5 8.5L8.5 3.5M8.5 3.5H4.5M8.5 3.5V7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                </a>
              ) : primary.sourceName ? (
                <span className="text-xs text-ink-faint">{primary.sourceName}</span>
              ) : null}
            </div>
            {otherSources.length > 0 ? (
              <details className="group mt-2.5">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-faint hover:text-ink-muted [&::-webkit-details-marker]:hidden">
                  <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 transition-transform group-open:rotate-90">
                    <path d="M4 2.5L8 6L4 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                  {otherSources.length === 1 ? "1 more source" : `${otherSources.length} more sources`} for this event
                </summary>
                <ul className="mt-2 space-y-1.5 border-l border-line/60 pl-4">
                  {otherSources.map((source) => (
                    <li key={source.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <ConfidenceBadge confidence={source.confidence} />
                      {source.sourceUrl ? (
                        <a href={source.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                          {source.sourceName ?? "Source"}
                          <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3">
                            <path d="M3.5 8.5L8.5 3.5M8.5 3.5H4.5M8.5 3.5V7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                          </svg>
                        </a>
                      ) : (
                        <span className="text-ink-faint">{source.sourceName ?? "Source"}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
