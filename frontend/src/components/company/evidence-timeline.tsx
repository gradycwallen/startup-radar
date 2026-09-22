import type { DiscoveryEvent } from "@/lib/data/types";
import { SignalBadge } from "./signal-badge";
import { formatDate } from "@/lib/derive/recency";
import { ConfidenceBadge } from "./confidence-badge";

export function EvidenceTimeline({ events }: { events: DiscoveryEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-ink-muted">No discovery events recorded for this company yet.</p>;
  }

  return (
    <ol className="relative space-y-6 border-l border-line pl-6">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span aria-hidden className="absolute -left-[29px] top-1 h-2.5 w-2.5 rounded-full border-2 border-canvas bg-accent" />
          <div className="flex flex-wrap items-center gap-2">
            <SignalBadge eventType={event.eventType} />
            <span className="text-xs text-ink-faint">{formatDate(event.eventDate) ?? formatDate(event.observedAt)}</span>
          </div>
          {event.headline ? <p className="mt-1.5 font-medium text-ink">{event.headline}</p> : null}
          {event.description ? <p className="mt-1 text-sm text-ink-muted">{event.description}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            <ConfidenceBadge confidence={event.confidence} />
            {event.sourceUrl ? (
              <a href={event.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                {event.sourceName ?? "Source"}
                <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3">
                  <path d="M3.5 8.5L8.5 3.5M8.5 3.5H4.5M8.5 3.5V7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </a>
            ) : event.sourceName ? (
              <span className="text-xs text-ink-faint">{event.sourceName}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
