import Link from "next/link";
import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { eventTypeMeta } from "@/lib/derive/event-type";
import { eventTimestamp } from "@/lib/derive/momentum";
import { recencyLabel } from "@/lib/derive/recency";

const ITEM_COUNT = 14;

/**
 * The masthead's live strip: each company's newest discovery event, newest first, scrolling like
 * a wire feed. Real rows only — the same memoized read every page already makes, so it costs no
 * extra query. The list is rendered twice back to back so the CSS marquee (`.ticker-track` in
 * globals.css) can loop seamlessly by translating exactly -50%; the copy is aria-hidden. Hovering
 * pauses it; under reduced motion it doesn't move and scrolls horizontally instead.
 */
export async function SignalTicker() {
  const { companies } = await getAllCompaniesWithEvents();
  const items = companies
    .flatMap((company) => {
      const event = company.events[0];
      return event ? [{ company, event, at: eventTimestamp(event) }] : [];
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, ITEM_COUNT);
  if (items.length === 0) return null;

  const list = (hidden: boolean) => (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 items-center">
      {items.map(({ company, event, at }) => (
        <li key={`${hidden ? "b" : "a"}-${event.id}`} className="flex items-center">
          <Link
            href={`/companies/${company.id}`}
            tabIndex={hidden ? -1 : undefined}
            className="group flex items-center gap-2 px-5 transition-colors duration-200"
          >
            <span className="text-ink transition-colors duration-200 group-hover:text-accent">{company.name}</span>
            <span className="text-accent/80">{eventTypeMeta(event.eventType).short.toLowerCase()}</span>
            <span className="text-ink-faint">{recencyLabel(new Date(at).toISOString())}</span>
          </Link>
          <span aria-hidden className="text-line-strong">
            /
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="ticker relative flex h-8 items-center overflow-hidden border-t border-line font-mono text-[11px] uppercase tracking-[0.08em]">
      <div className="z-10 flex h-full shrink-0 items-center gap-2 bg-canvas pl-4 pr-3 text-ink-muted sm:pl-6">
        <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />
        Latest signals
      </div>
      <div className="ticker-mask relative min-w-0 flex-1 overflow-hidden">
        <div className="ticker-track flex w-max">
          {list(false)}
          {list(true)}
        </div>
      </div>
    </div>
  );
}
