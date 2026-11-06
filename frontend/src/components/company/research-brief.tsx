import type { CompanyWithEvents, SignalIntelligence } from "@/lib/data/types";
import { formatDate } from "@/lib/derive/recency";

function sourceLabel(type: string): string {
  if (type === "github_repo") return "GitHub repository";
  if (type === "github_org") return "GitHub organization";
  if (type.startsWith("github")) return "GitHub";
  if (["greenhouse", "lever", "ashby"].some((name) => type.includes(name))) return "Hiring";
  if (type === "website") return "Website";
  return type.replaceAll("_", " ");
}

export function ResearchBrief({ company, intelligence }: { company: CompanyWithEvents; intelligence: SignalIntelligence }) {
  const latest = company.events[0];
  return <aside className="border border-accent/20 bg-accent-soft/60 p-6 sm:p-7">
    <p className="flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent"><span aria-hidden="true" className="h-2 w-2 bg-accent" />Research brief</p>
    <dl className="mt-6 space-y-6 text-sm">
      <div><dt className="text-xs uppercase tracking-wider text-ink-faint">Discovered through</dt><dd className="mt-1 text-ink">{company.discoveryUrl ? <a className="text-accent hover:underline" href={company.discoveryUrl} target="_blank" rel="noreferrer noopener">{company.discoverySource ?? "Original source"} ↗</a> : company.discoverySource ?? "Source not specified"} · {formatDate(company.discoveredAt)}</dd></div>
      {latest && <div><dt className="text-xs uppercase tracking-wider text-ink-faint">Latest discovery event</dt><dd className="mt-1 leading-relaxed text-ink">{latest.headline ?? latest.description ?? "Discovery event recorded"}{latest.sourceUrl && <> · <a href={latest.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{latest.sourceName ?? "Source"} ↗</a></>}</dd></div>}
      <div><dt className="text-xs uppercase tracking-wider text-ink-faint">Tracking and latest observation</dt><dd className="mt-2 text-ink-muted">{intelligence.unavailable ? "Signal history is temporarily unavailable." : intelligence.sources.length === 0 ? "No sources resolved yet." : <ul className="space-y-2">{intelligence.sources.map((source) => {
        const last = intelligence.observations.filter((o) => o.signalSourceId === source.id && !o.collectionVersion.includes("backfill")).map((o) => o.observedAt).sort().at(-1);
        return <li key={source.id}><span className="font-medium text-ink">{sourceLabel(source.sourceType)}</span> · {last ? `Observed ${formatDate(last)}` : "No live observation recorded yet"}</li>;
      })}</ul>}</dd></div>
    </dl>
  </aside>;
}
