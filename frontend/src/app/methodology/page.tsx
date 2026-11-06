import type { Metadata } from "next";
import { PageBanner } from "@/components/layout/page-banner";

export const metadata: Metadata = { title: "Methodology" };

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-8 first:border-t-0 first:pt-0">
      <h2 className="font-serif text-2xl text-ink">{heading}</h2>
      <div className="mt-3 max-w-2xl space-y-3 text-[15px] leading-relaxed text-ink-muted">{children}</div>
    </section>
  );
}

export default function MethodologyPage() {
  return (
    <>
    <PageBanner eyebrow="Methodology" title="How Startup Radar works">
      What Scout actually does, what the numbers on this site mean, and what we deliberately don&rsquo;t do.
    </PageBanner>
    <main className="mx-auto max-w-7xl px-6 pb-10 pt-8 sm:px-8 sm:pb-14 sm:pt-10">
      <div className="max-w-3xl">
        <Section heading="Discovery">
          <p>
            Every company here was surfaced by Scout, Startup Radar&rsquo;s discovery engine, from real public sources: funding
            announcements, accelerator cohort pages, stealth launches and product releases picked up across newsrooms, regional
            tech press and directory listings.
          </p>
          <p>
            Discovery is deterministic: extraction, filtering and ranking run on fixed rules, not a model guessing at what
            looks interesting. Nothing is invented: every entry links back to the real article or listing it came from, and the
            &ldquo;why it&rsquo;s on the radar&rdquo; line on each company is the actual evidence that got it accepted, not
            generated summary text.
          </p>
        </Section>

        <Section heading="Confidence">
          <p>
            Every company and every discovery event carries a confidence score, reflecting how well-evidenced that specific
            claim is, never a guess at the company&rsquo;s quality or prospects.
          </p>
          <ul className="list-inside list-disc space-y-1">
            <li><span className="font-medium text-ink">Strong evidence</span>: 90%+, typically multiple independent sources agreeing.</li>
            <li><span className="font-medium text-ink">Moderate evidence</span>: 75–89%, a credible single source or thinner corroboration.</li>
            <li><span className="font-medium text-ink">Emerging signal</span>: below 75%, or not yet rated: still worth surfacing, less certain.</li>
          </ul>
        </Section>

        <Section heading="Momentum">
          <p>
            Momentum answers &ldquo;which companies deserve attention right now,&rdquo; from data already on the page, never a
            hidden score. It counts how many distinct signals a company has shown (a funding round, a product launch, a stealth
            exit, and so on) and weights each one by how recent it is: a signal from today counts in full, one from two weeks
            ago counts half, and anything older than about three months drops out.
          </p>
          <p>
            A signal is one news cycle, not one article. Everything reported about a company within the same week, by any
            number of outlets, counts as a single signal. How well a signal is sourced is what Confidence measures; Momentum is about how much is happening.
          </p>
          <p>The underlying score is never shown as a number, only the High/Medium/Low band, the signal count and the latest activity date.</p>
        </Section>

        <Section heading="Signal Intelligence">
          <p>
            Beyond discovery, Scout revisits a subset of companies over time and tracks real change across three areas: hiring
            activity, GitHub activity, and website structure (pricing, enterprise and security pages appearing, and so on).
          </p>
          <p>
            Two distinct kinds of evidence appear on a Company Detail page, and we&rsquo;re careful never to blur them:
          </p>
          <ul className="list-inside list-disc space-y-1">
            <li><span className="font-medium text-ink">First observed</span>: the state Scout saw the first time it looked. Not a claim that anything changed, just what was true at first look.</li>
            <li><span className="font-medium text-ink">Confirmed change</span>: a real transition witnessed over time (e.g. a pricing page appearing where none existed before), only shown once it&rsquo;s been confirmed on a second, independent pass.</li>
          </ul>
        </Section>

        <Section heading="What we don't do">
          <p>
            We don&rsquo;t fabricate enrichment. If a founder name, funding stage, headcount or similar detail isn&rsquo;t
            something Scout actually found evidence for, it simply isn&rsquo;t shown, never guessed or generated to fill a
            field. We also don&rsquo;t run a general-purpose AI model over the open web to invent candidates: discovery is
            rule-based specifically so every result traces back to a real, checkable source.
          </p>
        </Section>

        <Section heading="Data">
          <p>
            The current dataset is available as a plain export, the same records the site renders, nothing extra, no
            key required:{" "}
            <a href="/api/companies" className="font-medium text-accent hover:underline">
              JSON
            </a>
            {" · "}
            <a href="/api/companies?format=csv" className="font-medium text-accent hover:underline">
              CSV
            </a>
            .
          </p>
        </Section>

        <Section heading="Disclaimer">
          <p>
            Startup Radar is an evidence-tracking product, not financial or investment advice. Confidence and Momentum
            describe how well-evidenced and how active something appears in public sources, not a recommendation to invest,
            work for, or partner with any company listed here.
          </p>
        </Section>
      </div>
    </main>
    </>
  );
}
