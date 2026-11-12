import Link from "next/link";
import type { CompanyWithEvents } from "@/lib/data/types";
import { Eyebrow } from "@/components/ui/eyebrow";

// Manually reviewed examples, selected for independently corroborated identities, discovery
// sources and existing observation histories. Match on domain as well as id to avoid stale links.
const EXAMPLES = [
  { id: 3, domain: "githits.com", label: "Developer tools", note: "Follow a funding discovery and a history of GitHub activity." },
  { id: 54, domain: "restate.dev", label: "Infrastructure", note: "Explore a funding announcement alongside observed development activity." },
  { id: 11, domain: "chamelio.ai", label: "Legal technology", note: "Explore a funding announcement and hiring and website observations." },
] as const;

export function StartExploring({ companies }: { companies: readonly CompanyWithEvents[] }) {
  const examples = EXAMPLES.flatMap((example) => {
    const company = companies.find((c) => c.id === example.id && c.domain === example.domain && c.discoveryUrl && (c.activitySignals?.length ?? 0) > 0);
    return company ? [{ ...example, company }] : [];
  });
  if (!examples.length) return null;
  return <section className="mt-10 border-t border-line-strong pt-6" aria-labelledby="start-exploring">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><div><Eyebrow>A place to start</Eyebrow><h2 id="start-exploring" className="mt-2 font-serif text-2xl tracking-tight">Explore the evidence</h2></div><p className="text-xs text-ink-muted">Selected examples with discovery sources and signal history.</p></div>
    <div className="mt-5 grid gap-px border border-line bg-line sm:grid-cols-3">{examples.map(({ company, label, note }) => <Link key={company.id} href={`/companies/${company.id}`} className="group bg-canvas p-5 transition-colors hover:bg-accent-soft"><p className="font-mono text-[10px] font-medium uppercase tracking-[0.15em] text-ink-faint">{label}</p><h3 className="mt-2 font-serif text-lg tracking-tight">{company.name} <span aria-hidden="true">↗</span></h3><p className="mt-2 text-sm leading-relaxed text-ink-muted">{note}</p></Link>)}</div>
  </section>;
}
