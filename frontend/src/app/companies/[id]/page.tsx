import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCompanyById } from "@/lib/data/companies";
import { getSignalIntelligenceForCompany } from "@/lib/data/signals";
import { ConfidenceBadge } from "@/components/company/confidence-badge";
import { EvidenceTimeline } from "@/components/company/evidence-timeline";
import { SignalIntelligenceSection } from "@/components/company/signal-intelligence-section";
import { DataSourceBanner } from "@/components/ui/data-source-banner";
import { CompanyLogo } from "@/components/ui/company-logo";
import { categoryLabelClasses } from "@/lib/derive/category-color";
import { formatDate, recencyLabel } from "@/lib/derive/recency";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

export async function generateMetadata({ params }: PageProps<"/companies/[id]">): Promise<Metadata> {
  const { id } = await params;
  const parsed = parseId(id);
  if (parsed === null) return { title: "Company not found" };
  const { company } = await getCompanyById(parsed);
  return { title: company ? company.name : "Company not found" };
}

export default async function CompanyDetailPage({ params }: PageProps<"/companies/[id]">) {
  const { id } = await params;
  const parsed = parseId(id);
  if (parsed === null) notFound();

  const { source, company } = await getCompanyById(parsed);
  if (!company) notFound();

  const intelligence = await getSignalIntelligenceForCompany(company.id);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 sm:px-8 sm:py-16">
      <Link href="/" className="text-sm font-medium text-ink-faint hover:text-ink">
        ← Radar
      </Link>

      <DataSourceBanner source={source} />

      <header className="mt-6 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-8">
        <div className="flex gap-5">
          <CompanyLogo domain={company.domain} name={company.name} size={56} />
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-serif text-4xl tracking-tight text-ink sm:text-5xl">{company.name}</h1>
              {company.category ? <span className={categoryLabelClasses()}>{company.category}</span> : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
              <a href={`https://${company.domain}`} target="_blank" rel="noreferrer noopener" className="font-medium text-accent hover:underline">
                {company.domain}
              </a>
              {company.foundedYear ? <span>Founded {company.foundedYear}</span> : null}
              <span>Discovered {recencyLabel(company.discoveredAt)}</span>
            </div>
          </div>
        </div>
        <ConfidenceBadge confidence={company.confidence} />
      </header>

      {company.description ? <p className="mt-8 max-w-2xl text-lg leading-relaxed text-ink-muted">{company.description}</p> : null}

      {company.discoveryReason ? (
        <div className="mt-8 max-w-2xl border-l-2 border-accent/50 pl-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-accent">Why it&rsquo;s on the radar</p>
          <p className="mt-2 font-serif text-xl leading-snug text-ink">{company.discoveryReason}</p>
          {company.discoverySource ? (
            <p className="mt-2.5 text-xs text-ink-muted">
              Original discovery source: {company.discoveryUrl ? (
                <a href={company.discoveryUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-accent hover:underline">
                  {company.discoverySource}
                </a>
              ) : (
                company.discoverySource
              )}
              {" · "}
              {formatDate(company.discoveredAt)}
            </p>
          ) : null}
        </div>
      ) : null}

      <SignalIntelligenceSection intelligence={intelligence} />

      <section className="mt-14 max-w-3xl">
        <h2 className="font-serif text-2xl text-ink">Discovery timeline</h2>
        <p className="mt-1.5 text-sm text-ink-muted">Every event Startup Radar has recorded for {company.name}, most recent first.</p>
        <div className="mt-6">
          <EvidenceTimeline events={company.events} />
        </div>
      </section>
    </main>
  );
}
