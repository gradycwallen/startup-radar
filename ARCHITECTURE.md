# Architecture

A short, external-facing overview of how Startup Radar is built. For the full internal engineering
log — every decision, every mistake, every milestone, kept up to date across the project's whole
history — see [`CLAUDE.md`](CLAUDE.md). This file is the five-minute version.

## What it is

Two systems under one product:

- **Scout** (`src/`) — the backend discovery and observation engine. A set of CLIs and scheduled
  jobs with no user interface.
- **The frontend** (`frontend/`) — a read-only Next.js app that presents whatever Scout has found.
  It never writes to the database and never calls an LLM.

## Data flow

```
Source providers (RSS / Google News / YC / Techstars)
        │  SourceItem
        ▼
Deterministic extraction + prefilter + entity clustering     — regex/heuristic, NO LLM
        ▼
Existing-company matching + domain resolution                — read-only against Supabase
        ▼
Deterministic ranking (8 weighted, logged components)
        ▼
Two-track finalist selection (news / directory)
        ▼
Controlled writes — new companies + their initial events only, under hard per-run caps
        ▼
Signal Intelligence — hiring (ATS), GitHub, website-structure observers, revisited daily
```

Two GitHub Actions workflows run this unattended, once a day each: discovery, then signal
observation. Both are allowed to find nothing new on a given day — that's a valid, expected
outcome, not a failure.

## The two decisions that shaped the system

**Deterministic over agentic.** The first version of discovery used one Claude call per category —
web search and web fetch to both find and verify candidates. It worked, but one category took
roughly 20 minutes on a real run, and the worst-case cost per request ran to $2+ against a $0.75
budget ceiling. An open-ended agentic loop can't run daily under a fixed cost ceiling. Discovery is
now a fully deterministic pipeline — real RSS/directory feeds, rule-based extraction and ranking,
zero LLM calls anywhere in that path, enforced by a static test that fails the build if an
Anthropic import or a model name string appears under `src/funnel/`, `src/sources/`, or `src/eval/`.

**A wrong match is worse than no match.** A feature once guessed a company's domain from its name
and verified the guess by checking whether the company's name appeared on the resulting homepage.
A precision audit found real false positives — the check proved a name collision, not an identity
match. The feature was reverted. The rule that came out of it governs every identity decision in
the codebase since: an unresolved match is the correct outcome when evidence is thin, never
something to force.

## Database posture

Supabase/Postgres is the system of record. Two write-capable files exist in the entire codebase,
each enforced by a static test that inspects every write call by table name:

- `src/discovery/store.ts` — inserts new companies and their initial discovery events only. Never
  updates an existing company's fields.
- `src/signals/store.ts` — inserts into `signal_sources` / `observations` / `signals` only.
  `observations` and `signals` are append-only at the database grant level, not just by
  convention — the service-role credentials themselves have no UPDATE/DELETE on those two tables.

Every other file that touches the database is read-only, including the frontend's entire data
layer.

## Signal Intelligence

Three independent, deterministic signal families, each observed on its own freshness cadence:

| Family | Source | What it tracks |
|---|---|---|
| `github` | GitHub's public REST API | Stars, forks, contributors, commit activity, releases |
| `hiring` | Greenhouse / Lever / Ashby (public, no-auth APIs) | Open roles, role categories, specific hire types |
| `website` | The company's own homepage | Pricing/enterprise/security/customer-proof pages appearing, pre-launch markers |

A non-negotiable rule holds across all three: a metric a collector couldn't observe is written as
*missing*, never defaulted to zero. This is enforced by regression tests, not just documentation.

## Analysis tools (`src/analysis/`)

Read-only CLIs that ask specific questions of the accumulated data, separate from the product
itself — corroboration rate, a lead-time backtest, SEC Form D candidate matching, momentum decay.
Each is deterministic, makes zero Anthropic calls, and is documented with its live result and
limitations in `docs/`.

## Frontend

Next.js (App Router), reads Supabase with a server-only service-role client — the key never
reaches the browser. Falls back to a clearly-labeled sample dataset when no database credentials
are configured, so a visitor can always see the product. Pages: Radar (the feed), Explore (search/
filter), Company Detail (evidence timeline + activity charts), Insights (dataset-wide trends),
Methodology, About.
