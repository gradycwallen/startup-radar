# Startup Radar

Startup Radar is a tool I built to discover emerging startups and follow what they do over time. It collects companies from public sources, tracks changes in hiring, GitHub activity, and websites, and puts the evidence in a searchable directory.

I wanted to explore how an investor might find early signals while building a system that is honest about what it knows. The product is a starting point for research: public sources can be incomplete, company matches can be wrong, and a signal is not an investment recommendation.

## What you can explore

- **Radar and Explore:** browse companies, search and filter the directory, and sort by momentum or recency.
- **Company profiles:** see discovery events, observed activity, signals, and available source links in one place.
- **Methodology and About:** see how the system works and read the decisions and mistakes behind it.

An observation is a recorded measurement; a signal is a finding derived from observations. Momentum weights distinct signals by recency. A first observation establishes a baseline, so it shouldn't be mistaken for a change.

## Two things I learned building it

**Discovery needed a tighter process.** My first approach used Claude with web search to find and verify companies. A real run took around 20 minutes for one category, and the estimated worst-case cost was over $2 against a $0.75 budget. I replaced that discovery path with source feeds, extraction rules, entity matching, and ranking. The current discovery pipeline does not make LLM calls; a static test checks that boundary. The earlier approach remains in the repository for reference.

**A matching result is not necessarily the right company.** I once shipped a feature that guessed domains from company names and checked whether the name appeared on the resulting homepage. An audit found two wrong matches among the first ten: Ande matched an unrelated DNA-testing company, and Travix matched an unrelated travel company. The check had confirmed a name collision, not the startup's identity. I reverted the feature. That experience changed how I think about missing data: I'd rather leave a domain unresolved than attach the wrong company to it.

The [About page](frontend/src/app/about/page.tsx) goes into more detail on both decisions.

## Run the frontend

You'll need Node.js 24 or newer. The frontend can run with a labeled sample dataset without database credentials:

```bash
cd frontend
npm ci
npm run dev
```

Open the local address printed in the terminal. To use your own Supabase data, copy `frontend/.env.local.example` to `frontend/.env.local` and fill in the URL and service-role key. Keep the key server-side and out of version control. See the [frontend README](frontend/README.md) for more detail.

## How it works

1. Source providers collect public items from RSS, Google News, and accelerator directories.
2. The discovery pipeline extracts and clusters candidates, resolves identities where it can, and ranks them using rules. Controlled writes add selected companies and discovery events.
3. Signal collectors revisit companies and record hiring, GitHub, and website observations. Rules turn qualifying changes into signals.
4. The Next.js frontend reads the resulting data from Supabase and presents it alongside the available evidence.

Scheduled GitHub Actions workflows run discovery and signal collection. The source coverage and matching rules have limits, so results still need review. A failed observation is treated as unknown rather than zero, and website changes require confirmation across observations.

The main parts of the repository are:

- `src/sources/` and `src/funnel/`: source collection, extraction, matching, and ranking.
- `src/discovery/` and `src/signals/`: controlled discovery writes and signal collection.
- `src/eval/`: offline evaluation of the discovery pipeline.
- `frontend/`: the read-only Next.js application.
- `.github/workflows/`: scheduled jobs and checks.

[`CLAUDE.md`](CLAUDE.md) contains more project context and historical implementation notes.

## Checks

From the repository root:

```bash
npm ci
npm test
npm run typecheck
```

For the frontend:

```bash
cd frontend
npm ci
npm test
npm run lint
npm run build
```

Startup Radar is an evidence-tracking project, not financial or investment advice.
