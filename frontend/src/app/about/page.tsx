import type { Metadata } from "next";
import Link from "next/link";
import { PageBanner } from "@/components/layout/page-banner";
import { getAllCompaniesWithEvents } from "@/lib/data/companies";

export const metadata: Metadata = { title: "About" };

// Without this, Next.js statically prerenders this page at build time (it has no searchParams to
// force dynamic rendering the way Radar/Explore get for free) — which would freeze the company
// count below at whatever it was during the last deploy, contradicting the page's own point that
// the number is real and live. Revalidate hourly rather than per-request: this count doesn't need
// to be second-fresh, just not permanently stale.
export const revalidate = 3600;

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-8 first:border-t-0 first:pt-0">
      <h2 className="font-serif text-2xl text-ink">{heading}</h2>
      <div className="mt-3 max-w-2xl space-y-3 text-[15px] leading-relaxed text-ink-muted">{children}</div>
    </section>
  );
}

export default async function AboutPage() {
  const { source, companies } = await getAllCompaniesWithEvents();

  return (
    <>
      <PageBanner eyebrow="About" title="Why this exists, and how it was built">
        The real engineering story: what worked, what didn&rsquo;t, and what I&rsquo;d do differently.
      </PageBanner>
      <main className="mx-auto max-w-7xl px-6 pb-10 pt-8 sm:px-8 sm:pb-16 sm:pt-10">
        <div className="max-w-3xl">
          <div className="mb-10 grid gap-6 border border-line bg-accent-soft/40 p-6 sm:grid-cols-3">
            <div><p className="text-xs font-semibold uppercase tracking-wider text-accent">The problem</p><p className="mt-2 text-sm leading-relaxed text-ink-muted">Early startup signals are scattered across public sources and difficult to assess consistently.</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-wider text-accent">What I built</p><p className="mt-2 text-sm leading-relaxed text-ink-muted">A deterministic discovery and observation pipeline with source-linked company profiles.</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-wider text-accent">What I learned</p><p className="mt-2 text-sm leading-relaxed text-ink-muted">Bounded systems are easier to operate, and uncertain identity matches need independent evidence.</p></div>
          </div>
          <Section heading="Why I built this">
            <p>
              I wanted to understand what it actually takes to evaluate something as uncertain as an early-stage startup,
              not by reading about it, but by building a system that has to make that call, over and over, on real
              companies, and show its work every time. Startup Radar is a discovery engine: it finds emerging companies
              from public sources like funding announcements, accelerator cohorts, and stealth launches before they&rsquo;re
              widely covered, and records confidence and source links so readers can examine the evidence themselves.
            </p>
            <p>
              {source === "supabase" ? <>The current directory contains <span className="font-medium text-ink">{companies.length} companies</span>, discovered and ranked by code.</> : <>Live data is unavailable, so the directory is showing a labeled sample.</>} Source links support independent review, and an incorrect match can still require correction.
            </p>
          </Section>

          <Section heading="The decision I keep coming back to: deterministic over agentic">
            <p>
              The first version of Scout (the discovery engine) worked the way you&rsquo;d probably guess: one Claude call
              per category (funding, stealth, or launches), using web search and web fetch to both find candidates and
              verify them. It worked. It also took roughly <span className="font-medium text-ink">20 minutes</span> for a
              single category on a real run, and the worst-case cost per request ran to roughly{" "}
              <span className="font-medium text-ink">$2+</span> against a budget I&rsquo;d set at $0.75 per run. An
              open-ended agentic loop simply can&rsquo;t run daily under a fixed, honest cost ceiling; the ceiling would
              refuse it almost every time.
            </p>
            <p>
              So I rebuilt discovery as a fully deterministic pipeline: real RSS and directory feeds, regex/heuristic
              extraction, rule-based filtering, a transparent weighted ranking, <span className="font-medium text-ink">
              zero LLM calls anywhere in the path</span>, enforced by a static test that fails the build if an Anthropic
              import or a model name ever appears under that code. It now runs daily, unattended, for effectively free.
            </p>
            <p>
              That&rsquo;s the opinion I&rsquo;d defend: AI is genuinely good at narrow, bounded judgment calls on
              already-surfaced evidence, not at being the thing that goes and finds the evidence in the first place,
              when a few hundred lines of deterministic code can do that more cheaply, faster, and more reproducibly.
              Reserve the model for the part a rule genuinely can&rsquo;t do.
            </p>
          </Section>

          <Section heading="A mistake I shipped, caught, and reverted">
            <p>
              At one point I built a feature to guess a company&rsquo;s domain from its name when the real source URL
              was an unfetchable redirect, verifying each guess by checking whether the company&rsquo;s name appeared on
              the resulting homepage. In a live precision audit, two of the first ten guesses it &ldquo;verified&rdquo;
              were wrong in a specific, bad way: a funded startup called <span className="font-medium text-ink">Ande</span>{" "}
              matched <code className="text-sm">ande.com</code>, which is actually ANDE, an unrelated, already-established
              forensic DNA-testing company. A startup called <span className="font-medium text-ink">Travix</span> matched{" "}
              <code className="text-sm">travix.com</code>, an unrelated 450-employee travel agency.
            </p>
            <p>
              Both passed verification because the real, different company&rsquo;s own homepage naturally contains its
              own name. The check was proving a name collision, not an identity match. I reverted the feature
              completely rather than ship something that could attach a real company&rsquo;s profile to the wrong
              business. The core rule I took from it, now written into the project&rsquo;s own engineering notes: a
              wrong domain is worse than a missing company. An unresolved match is the correct outcome when evidence is
              thin, not a bug to paper over.
            </p>
          </Section>

          <Section heading="What I&rsquo;d change if I started over">
            <ul className="list-inside list-disc space-y-2">
              <li>
                <span className="font-medium text-ink">Build the deterministic path first.</span> I built the expensive,
                agentic version before I&rsquo;d proven the cheap version couldn&rsquo;t work. It should have been the
                other way around.
              </li>
              <li>
                <span className="font-medium text-ink">Throttle growth against observation depth.</span> The company list
                grows faster than any one company accumulates history, so most of what Signal Intelligence shows today
                is a first-look snapshot, not a real change over time. I&rsquo;d cap new-company intake against how fast
                the system can actually build longitudinal evidence, instead of treating discovery volume and signal
                depth as separate goals.
              </li>
              <li>
                <span className="font-medium text-ink">Invest in domain resolution earlier.</span> It&rsquo;s still the
                weakest link in the whole pipeline. A meaningful share of discovered companies have no resolved domain
                at all, and the one attempt to fix that algorithmically is the mistake above. I&rsquo;d treat it as a
                first-class problem from day one, not something to patch in later.
              </li>
            </ul>
          </Section>

          <Section heading="Why AI operations and evaluating startups">
            <p>
              What pulled me into this project is the same thing that pulls me toward both of those: the interesting
              problem isn&rsquo;t generating more output, it&rsquo;s deciding what to trust, under real uncertainty, with
              a system that has to be honest about what it doesn&rsquo;t know. That&rsquo;s true of an AI tool deciding
              whether to call a company &ldquo;funded&rdquo; or just &ldquo;mentioned,&rdquo; and it&rsquo;s true of an
              investor deciding whether early traction is real. I like the operational side of that problem as much as
              the investment-judgment side of it, building the system that surfaces the signal cleanly, and then
              actually reasoning about what the signal means.
            </p>
          </Section>

          <Section heading="What&rsquo;s under the hood">
            <p>
              The full technical writeup covering the pipeline, safeguards, and limitations lives
              in the project&rsquo;s own engineering notes alongside the code. The short version: a $0.75 hard budget
              ceiling with pre-flight reservation, an append-only ledger of every lead found regardless of outcome, an
              offline snapshot/replay system so the entire test suite runs with zero network calls and zero spend, and
              two, and only two, files in the whole codebase allowed to write to the database, each one enforced by a
              static test that inspects every write call by name.
            </p>
            <p>
              <Link href="/methodology" className="font-medium text-accent hover:underline">
                Read the product-facing methodology
              </Link>
              {" · "}
              <a
                href="https://github.com/gradycwallen/startup-radar"
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-accent hover:underline"
              >
                Browse the source
              </a>
              {" · "}
              <a href="/api/companies" className="font-medium text-accent hover:underline">
                Export the current dataset (JSON)
              </a>
            </p>
          </Section>
        </div>
      </main>
    </>
  );
}
