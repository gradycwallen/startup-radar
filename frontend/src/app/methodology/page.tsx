import type { Metadata } from "next";

export const metadata: Metadata = { title: "Methodology" };

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-8 first:border-t-0 first:pt-0">
      <h2 className="font-serif text-xl text-ink">{heading}</h2>
      <div className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed text-ink-muted">{children}</div>
    </section>
  );
}

export default function MethodologyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10 sm:py-14">
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Methodology</p>
      <h1 className="mt-1.5 font-serif text-3xl text-ink">How Startup Radar works</h1>
      <p className="mt-3 max-w-2xl text-sm text-ink-muted">
        What Scout actually does, what the numbers on this site mean, and what we deliberately don&rsquo;t do.
      </p>

      <div className="mt-8">
        <Section heading="Discovery">
          <p>
            Every company here was surfaced by Scout, Startup Radar&rsquo;s discovery engine, from real public sources: funding
            announcements, accelerator cohort pages, stealth launches and product releases picked up across newsrooms, regional
            tech press and directory listings.
          </p>
          <p>
            Discovery is deterministic — extraction, filtering and ranking run on fixed rules, not a model guessing at what
            looks interesting. Nothing is invented: every entry links back to the real article or listing it came from, and the
            &ldquo;why it&rsquo;s on the radar&rdquo; line on each company is the actual evidence that got it accepted, not
            generated summary text.
          </p>
        </Section>

        <Section heading="Confidence">
          <p>
            Every company and every discovery event carries a confidence score, reflecting how well-evidenced that specific
            claim is — never a guess at the company&rsquo;s quality or prospects.
          </p>
          <ul className="list-inside list-disc space-y-1">
            <li><span className="font-medium text-ink">Strong evidence</span> — 90%+, typically multiple independent sources agreeing.</li>
            <li><span className="font-medium text-ink">Moderate evidence</span> — 75–89%, a credible single source or thinner corroboration.</li>
            <li><span className="font-medium text-ink">Emerging signal</span> — below 75%, or not yet rated: still worth surfacing, less certain.</li>
          </ul>
        </Section>

        <Section heading="Momentum">
          <p>Momentum answers &ldquo;which companies deserve attention right now,&rdquo; from data already on the page — never a hidden score. It weighs three things:</p>
          <ul className="list-inside list-disc space-y-1">
            <li><span className="font-medium text-ink">Recency (50%)</span> — how fresh the company&rsquo;s latest activity is.</li>
            <li><span className="font-medium text-ink">Corroboration (30%)</span> — how many independent sources back that activity.</li>
            <li><span className="font-medium text-ink">Signal diversity (20%)</span> — how many different kinds of activity (funding, launch, hiring, and so on) have shown up recently.</li>
          </ul>
          <p>The underlying score is never shown as a number — only the High/Medium/Low band and the evidence behind it (source count, signal types, latest activity date).</p>
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
            <li><span className="font-medium text-ink">First observed</span> — the state Scout saw the first time it looked. Not a claim that anything changed, just what was true at first look.</li>
            <li><span className="font-medium text-ink">Confirmed change</span> — a real transition witnessed over time (e.g. a pricing page appearing where none existed before), only shown once it&rsquo;s been confirmed on a second, independent pass.</li>
          </ul>
        </Section>

        <Section heading="What we don't do">
          <p>
            We don&rsquo;t fabricate enrichment. If a founder name, funding stage, headcount or similar detail isn&rsquo;t
            something Scout actually found evidence for, it simply isn&rsquo;t shown — never guessed or generated to fill a
            field. We also don&rsquo;t run a general-purpose AI model over the open web to invent candidates: discovery is
            rule-based specifically so every result traces back to a real, checkable source.
          </p>
        </Section>

        <Section heading="Disclaimer">
          <p>
            Startup Radar is an evidence-tracking product, not financial or investment advice. Confidence and Momentum
            describe how well-evidenced and how active something appears in public sources — not a recommendation to invest,
            work for, or partner with any company listed here.
          </p>
        </Section>
      </div>
    </main>
  );
}
