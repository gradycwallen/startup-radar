# SEC Form D corroboration — feasibility and build notes, November 7, 2026

## The question

Can SEC EDGAR's own Form D filings (the government record of a Reg D exempt securities offering —
what a startup files when it closes a round) corroborate funding events Scout already tracks? A
primary, government-filed record is a different, more authoritative kind of evidence than a press
article.

## Access method

Three ways to reach this data were researched (full findings below); the one actually built
against is SEC's full-text search index, `https://efts.sec.gov/LATEST/search-index`:

- **Full-text search (`efts.sec.gov`)** — undocumented as a formal API but public, free, no key.
  Searches `doc_text` (the filing's full text) via `match_phrase`, filterable to `forms=D`. Best
  fit for *targeted, per-company lookups against companies we already track* — which is exactly
  this project's use case, not broad discovery of new filings.
- **Daily index / bulk quarterly datasets** (`sec.gov/dera/data/form-d`, `/Archives/edgar/daily-index/`)
  — better suited to comprehensive discovery of *every* Form D filed each day, which is a different
  problem (and carries the same name-only identity risk at much larger scale). Not used here.
- **Per-CIK submissions API** (`data.sec.gov/submissions/CIK##########.json`) — only useful once a
  company's CIK is already known; good for a future refresh step, not initial matching.

**Politeness**: SEC documents a 10 requests/second fair-access limit and requires a declared,
contact-bearing `User-Agent` — an undeclared one gets a `403 "Undeclared Automated Tool"` response
(confirmed live). This project paces at ~2.5 req/s and reads the contact email from
`SEC_CONTACT_EMAIL` (`.env`, gitignored) rather than hardcoding anything into committed source —
see `src/analysis/sec-form-d-main.ts`.

## The identity-matching constraint (the real design decision)

**SEC's search index has no website or domain field for a filer — only legal name, CIK, and
business-address state.** Every other source this project uses (RSS, Google News, YC, Techstars)
ultimately resolves to a domain; this one can only compare names. That is the exact failure shape
that produced the Ande/Travix mistake on the About page — two real, unrelated companies can share a
name. `src/analysis/sec-form-d.ts` is built around this constraint explicitly: it is a read-only,
candidate-only tool. It ranks hits by normalized name similarity (reusing `src/funnel/text.ts`'s
existing `nameKey`/`similarity`, the same primitives V2-1's own domain matching uses), drops
anything below 0.75 similarity as noise, and labels everything else "strong" (≥0.92) or "possible"
— never an acceptance. There is no write path in this module at all; it cannot misattribute a
filing to the wrong company because it never attaches anything to a company. A human reviews every
result.

## What's built

- `src/analysis/sec-form-d.ts` — pure matching/scoring, fully offline-testable
  (`matchFormDCandidates`, `formatCandidates`). 7 tests in `test/sec-form-d.test.ts`, including the
  Ande/Travix-shaped case explicitly (two companies sharing a name both score as candidates — the
  test asserts the module ranks and labels, not that it picks the "right" one, since that's
  deliberately left to a human).
- `src/analysis/sec-form-d-main.ts` — read-only CLI (`npm run analyze:sec-form-d`), reusing
  `ReadOnlyDb` for the company list (one new narrow method, `getCompanyNames()`) and
  `PoliteFetcher` for the SEC requests, same shared infrastructure every other source provider
  uses.

## Live verification — what was actually confirmed, and the one thing that wasn't

The parsing and matching logic was verified against SEC's real, live response shape: a known real
Form D filer ("OneDome Global, Inc.") was queried directly and returned a response structurally
identical to what `src/analysis/sec-form-d-main.ts` expects (`hits.hits[]._source.{display_names,
ciks, file_date, biz_states, adsh}`) — confirming the parser is correct, not just plausible.
Several of this project's own tracked companies (GitHits, Chamelio, Restate, Definite, machine0)
were also queried directly and returned zero hits — a genuine, structurally-confirmed absence
(the query mechanics work; these specific names just aren't in the index), not a bug. This is
expected: several of Scout's own discovery sources (`tech-eu`, `eu-startups`, `arcticstartup`,
`sifted`) are European, and Form D only covers US Reg D exempt offerings — a meaningful share of
tracked companies were never going to appear here regardless of real funding status, and that's a
real, disclosed limitation of this corroboration source, not a flaw in the matching logic.

**What could not be verified**: an actual end-to-end run of `npm run analyze:sec-form-d` from
*this development environment's shell*. SEC enforces its fair-access policy at the IP level, not
just by User-Agent — this sandbox's outbound IP returns the same `403 "Undeclared Automated Tool"`
response regardless of a correctly-declared, contact-bearing User-Agent (confirmed by replicating
the identical query from a different network path via the browser tool, which succeeded cleanly).
This is an environmental property of where this session's shell commands run, not a defect in the
tool. **The CLI should be run from a normal developer machine** (expected to work there, same as
any other `curl`/browser request to this public endpoint) to get real results against the full
company list.
