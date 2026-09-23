# Startup Radar — Project Guide for Claude Code

This file is durable context for any Claude Code session working on this repository. It reflects the
state of the project as of **V2-1 complete** (2026-09-21/22). Read it before making changes — especially
before touching the database, the safety/budget machinery, or anything under `src/funnel/` or `src/sources/`.

Status labels used throughout this document: **[BUILT]** = implemented and tested today. **[PLANNED]** =
intended direction, not yet implemented. Do not treat a `[PLANNED]` item as existing.

---

## 1. Product vision

**Startup Radar** discovers genuinely emerging, still-obscure startups — funding rounds, stealth
launches, accelerator cohorts, product launches — *before* they become obvious/widely covered, and
turns that into a browsable intelligence product: which companies are worth watching, why, and on what
evidence.

The problem it solves: by the time a startup is easy to find (a TechCrunch front-page story, a
trending LinkedIn post), the informational edge is gone. Startup Radar's discovery engine ("Scout")
is built to surface signal from many smaller/regional sources, accelerator directories, and niche
feeds — cheaply and continuously enough to run every day — rather than relying on a person or an LLM
to go looking.

Two distinct things make up the project, at different maturity levels:

- **Scout** — the backend discovery engine **[BUILT, backend only]**. A CLI/pipeline that finds
  candidate companies and events, verifies/filters them deterministically, and (once Phase 2 is
  approved) will write them to the database. No UI. This is everything under `src/`.
- **Startup Radar (the product)** — the eventual user-facing application built on top of the data
  Scout collects: a radar feed, company profiles, evidence trails, search **[PLANNED, not started]**.
  See §10.

---

## 2. System architecture

### High-level data flow (current, V2-1)

```
Source providers (RSS / Google News / YC / Techstars)
        │  SourceItem (title, url, published_at, excerpt, outbound links, structured fields)
        ▼
Deterministic extraction  (src/funnel/extract.ts)      — regex/heuristic, NO LLM
        │  RawLead  (also written to the lead ledger immediately — every lead, no matter what happens next)
        ▼
Deterministic prefilter  (src/funnel/prefilter.ts)      — drops funds/investors/large/public/late-round
        ▼
Entity clustering  (src/funnel/entities.ts)             — union-find de-dup across providers/lanes, evidence merged
        ▼
Existing-company matching  (src/funnel/existing.ts)      — against Supabase companies/discovery_events (READ-ONLY)
        ▼
Domain resolution + article/homepage enrichment  (src/funnel/domains.ts, src/http.ts)
        ▼
Deterministic ranking  (src/funnel/rank.ts)              — 8 weighted, logged components
        ▼
Two-track finalist selection  (news track + directory track, lane/provider diversity reservations)
        ▼
[PLANNED — not built] Verification / escalation (Haiku triage, Sonnet for ambiguous cases)
        ▼
[PLANNED — not built] Database writes (companies + discovery_events)
```

A separate, older pipeline (`src/main.ts` / `src/pipeline.ts`, "Phase 1") still exists: it discovers via
Claude's `web_search`/`web_fetch` tools directly instead of the deterministic funnel above, feeding the
same verification/validation/dedup/database layers. It is **dry-run only**, functional, tested, but no
longer the primary discovery path — see §4 for why.

### Supabase's role

Supabase (Postgres) is the system of record for accepted companies and discovery events. Today Scout
only **reads** it (to load existing companies/domains for de-duplication and existing-company matching).
**No code path writes to the database anywhere in this repository right now** — see §3 and §7.

### Important directories/files

| Path | Responsibility |
|---|---|
| `src/main.ts`, `src/pipeline.ts` | **Phase 1** CLI and orchestration: Claude-web discovery → verify → validate → dedupe → (no writes yet). |
| `src/providers/claude-web.ts` | The one Phase 1 `DiscoveryProvider`: Claude `web_search`/`web_fetch`, one call per lane. |
| `src/verify.ts`, `src/validate.ts` | `Verifier` interface (Claude-backed) and deterministic acceptance rules (domain, source provenance, event type/date, eligibility, confidence caps, homepage check). |
| `src/dedupe.ts` | Domain dedup, `(company, normalized source_url)` dedup, same-underlying-event heuristics. |
| `src/models.ts` | `ModelRouter` — the one place model choice is made for Phase 1's discover/verify calls. |
| `src/claude.ts` | Anthropic SDK wrapper: timeouts, retries, request/cost logging. |
| `src/budget.ts` | `$0.75` absolute budget ceiling + cost ledger (V2-0). |
| `src/ledger.ts` | Raw-lead ledger: every lead, every disposition, written incrementally (V2-0). |
| `src/snapshot.ts` | HTTP + DB record/replay for **Phase 1** offline runs (V2-0). |
| `src/db.ts` | `ReadOnlyDb` — the only file that imports `@supabase/supabase-js`; select/count only. |
| `src/deadline.ts`, `src/shutdown.ts`, `src/fatal.ts` | Timeout scopes, graceful SIGINT/SIGTERM, fatal-API-error abort. |
| `src/sources/` | **V2-1** source providers: `types.ts` (`SourceItem`/`SourceProvider`), `fetcher.ts` (`PoliteFetcher`, the *only* way providers touch the network), `feed.ts`/`html.ts` (RSS/HTML parsing), `providers/{rss-feed,google-news,yc,techstars}.ts`, `registry.ts` (`defaultSourceProviders`). |
| `src/funnel/` | **V2-1** deterministic funnel: `extract.ts` (headline → lead, no LLM), `prefilter.ts`, `entities.ts` (clustering), `domains.ts` (domain resolution), `existing.ts` (`ExistingIndex`, DB-backed dedup), `rank.ts` (scoring + two-track selection), `funnel.ts` (`runFunnel`, orchestration), `item-ledger.ts`, `report.ts`, `snapshot.ts` (funnel-specific snapshot format). |
| `src/funnel-main.ts` | **V2-1** CLI (`npm run funnel`). Live mode needs only Supabase credentials (no Anthropic key — the funnel makes zero LLM calls). `--replay` needs neither. |
| `src/eval/` | Offline evaluation harness: `labels.ts` (8 primary + 1 "separate" hand-labeled Phase-1 discoveries), `evaluate.ts` (runs the funnel against a snapshot and measures recall stage-by-stage), `run-eval.ts` (`npm run eval`). |
| `test/` | 26 test files, 257 tests. Includes static "guard" tests that fail the suite if a write-capable DB call, an Anthropic import, or a raw untimed-out fetch appears in the wrong place — see §7. |
| `.env` / `.env.example` | Credentials (gitignored). See §7. |
| `.mcp.json` | Local MCP server config (gitignored, never commit). |

**Frontend V1** now exists at `frontend/` — a separate Next.js (App Router) + TypeScript + Tailwind
app with its own `package.json`. It reads `companies`/`discovery_events` from Supabase **read-only**
(service-role key, server-only — never sent to the browser), and supports a user-toggleable
light/dark theme (persisted, respects OS preference on first visit, no flash on load). It is
completely decoupled from Scout: no discovery, no writes, no Anthropic calls. See §10 for what it
covers today and `frontend/README.md` for how to run it.

---

## 3. Current database

Confirmed live via read-only Supabase MCP inspection at the time of writing (Supabase project
`dpytmfomxfdrkmlldnel`). **Do not treat this as static — always re-check schema/counts live before
relying on them for a task, but do not modify them without explicit approval.**

### `public.companies` (10 rows)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `bigint` | no | identity (BY DEFAULT), PK |
| `created_at` | `timestamptz` | no | default `now()` |
| `name` | `text` | no | |
| `domain` | `text` | no | **UNIQUE** (`companies_domain_key`) |
| `description` | `text` | yes | |
| `category` | `text` | yes | |
| `discovered_at` | `timestamptz` | no | default `now()` |
| `discovery_source` | `text` | yes | |
| `discovery_url` | `text` | yes | |
| `confidence` | `double precision` | yes | |
| `discovery_reason` | `text` | yes | |
| `founded_year` | `smallint` | yes | only set when evidenced |

### `public.discovery_events` (10 rows)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `bigint` | no | identity (BY DEFAULT), PK |
| `created_at` | `timestamptz` | no | default `now()` |
| `company_id` | `bigint` | no | FK → `companies(id)` **ON DELETE CASCADE** |
| `event_type` | `text` | no | app-enforced enum, see below — **no DB CHECK constraint** |
| `event_date` | `date` | yes | |
| `source_name` | `text` | yes | |
| `source_url` | `text` | yes | |
| `headline` | `text` | yes | |
| `description` | `text` | yes | |
| `confidence` | `double precision` | yes | |
| `observed_at` | `timestamptz` | no | default `now()` |

**Constraints/relationships:** `companies_pkey`, `discovery_events_pkey`; `companies_domain_key` UNIQUE
on `domain`; `discovery_events_company_id_source_url_key` UNIQUE on `(company_id, source_url)`;
`discovery_events_company_id_fkey` FK with `ON DELETE CASCADE`. No CHECK constraints and no Postgres
enum types exist — `event_type` (`funding`/`product_launch`/`accelerator`/`news`/`open_source`/`stealth`,
`src/config.ts: EVENT_TYPES`) is validated by the application (`src/validate.ts`, zod in `src/schema.ts`),
not the database.

**RLS and grants (both tables):** RLS is **enabled** with **zero policies**. `service_role` is granted
only **SELECT, INSERT, UPDATE** — explicitly **no DELETE, TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN**
(revoked deliberately, see migrations below). `anon`/`authenticated` have no grants at all. `postgres`
(the owner role) retains full privileges, as normal.

**Migrations applied** (7, chronological): `companies_discovered_at_default_now`,
`companies_add_discovery_reason_founded_year`, `create_discovery_events_table`,
`discovery_events_add_observed_at`, `grant_service_role_select_insert_update_on_discovery_tables`,
`revoke_truncate_references_trigger_on_discovery_tables`, `revoke_maintain_on_discovery_tables`.

### Read/write posture — intentionally frozen

- **Database V1 (this schema) is FROZEN.** No schema/migration/permission/RLS/constraint/index change
  without the user explicitly asking for it.
- **No code in this repository writes to the database.** Every current entry point (`src/main.ts`,
  `src/funnel-main.ts`) is read-only; `--write` on the Phase 1 CLI is explicitly refused. This is
  enforced by a static test, not just convention (§7, §11).
- The 10 seeded companies/events came from a one-time manual Phase 1 research pass, not from a live
  Scout run. They are the fixed baseline every dedup/recall test is measured against — **do not treat
  the row count as an accident to "fix" by inserting more data.**

---

## 4. History and why the architecture exists

Reconstructed from code comments, the README, migration history, and this project's own prior working
sessions (the git history itself is thin — see §12 note on this).

**Phase 1 (Claude web-search discovery).** The original design: one Claude call per "lane" (funding,
stealth, launches, accelerator, news, open_source) using the `web_search`/`web_fetch` tools to both find
candidates *and* verify them, then deterministic validation/dedup before a (not-yet-built) write. This
worked functionally — a live dry-run produced real, correct candidates (Project-S, Fin.com, Empirik,
Aiir, etc., now used as the eval labels in §5). But it had two structural problems:

1. **Latency/reliability.** A single funding lane took **~20.5 minutes** in one live run (the origin of
   the `LIMITS` comment in `src/config.ts`). The Anthropic SDK's own timeout only covers the wait for
   response headers, so an open stream could hang indefinitely without explicit wall-clock enforcement.
   This drove a full round of hardening: per-request/lane/candidate/run deadlines, abort-based
   cancellation (including cancelling SDK retry waits), a 15s DB-read deadline, graceful
   SIGINT/SIGTERM shutdown, and a `web_fetch` content cap (20,000 tokens) — all still in place and
   still exercised by Phase 1 today.
2. **Cost.** Even after hardening, an open-ended agentic web-search loop's *worst-case* cost estimate
   is too high to run safely under a small, fixed budget — roughly **$2+ per request** against the
   $0.75 ceiling adopted for V2. An approach that discovers via unbounded LLM tool loops cannot be run
   daily/cheaply with a hard ceiling; the ceiling would refuse it almost every time.

This led to an explicit decision: **make discovery deterministic-first**, and reserve LLM calls (later)
for narrow, bounded triage/verification — not for finding candidates in the first place.

**V2-0 (safety/budget/audit foundation).** Before rebuilding discovery, the guardrails were built and
proven independently of any specific discovery strategy: the raw-lead ledger (every lead recorded the
moment it's found, regardless of outcome), a hard `$0.75` absolute budget ceiling with pre-flight
reservation (never send a request that could exceed the remaining budget), fatal-API-error abort
(insufficient credit/auth/permission errors stop everything, not just one candidate), and offline
snapshot/replay (record real HTTP + DB reads once, then re-run the whole pipeline with **zero** network
and **zero** Anthropic calls for testing/CI). These protections are strategy-agnostic and now underpin
both Phase 1 and the V2-1 funnel.

**V2-1 (deterministic discovery funnel).** Replaced Claude web-search as the *primary* discovery
mechanism with the pipeline described in §2: real RSS feeds, Google News RSS as a gap-filler, and the
YC/Techstars directories, run through regex/heuristic extraction, deterministic prefiltering, clustering,
existing-company dedup, and a fully transparent weighted ranking — **no LLM involved anywhere in this
path**, enforced by a static guard test. This is what makes a daily run realistically free to run: it
costs Anthropic $0 and Supabase only read traffic.

**Lessons that must not be accidentally undone:**
- Do not reintroduce unbounded/open-ended web-search tool loops as a *primary* discovery mechanism —
  that is exactly the cost/latency problem V2 exists to avoid. Bounded, stateless AI triage (§6) is a
  different, still-unbuilt thing.
- Do not remove or weaken the wall-clock deadlines in `src/deadline.ts`/`src/config.ts` — they were
  added in direct response to a real 20-minute hang, and `AbortSignal.timeout()` (the built-in
  alternative) was found this session to leak a process-keeping timer if not paired with an explicit
  `clearTimeout` — see the pattern in `src/deadline.ts: timeoutScope` and `src/sources/fetcher.ts`.
- Do not weaken the budget guard's "reserve before send, charge full reservation on unknown outcome"
  conservatism — it is deliberately pessimistic.

---

## 5. Current V2-1 state

**Implemented:** the full pipeline in §2, from source providers through ranked, selected finalists.
Nothing past ranking is built — no verification/escalation stage, no writes.

**Providers (10, `src/sources/registry.ts`):** `techcrunch-startups`, `techcrunch-venture` (RSS),
`tech-eu`, `eu-startups`, `arcticstartup`, `sifted`, `prnewswire-vc` (RSS), `google-news` (windowed
`after:`/`before:` Google News RSS, 18 generic lane-tagged queries — the gap-filler, not a primary
source), `yc-directory` (YC batch pages; only started, real batches), `techstars-cohorts` (newsroom
cohort pages, URL-pattern-restricted). Each carries a hand-set reliability prior used in ranking.

**Funnel stages** (`src/funnel/funnel.ts: runFunnel`, defaults in `DEFAULT_FUNNEL_CONFIG`): fetch items
within a `windowDays` (default 3) recency window → deterministic extraction → prefilter (drops
fund/investor raises, programs-not-companies, public companies, late rounds) → union-find entity
clustering across providers/lanes (evidence preserved per source) → match against existing Supabase
companies (`ExistingIndex`, read-only) → domain resolution (structured field → name-shaped domain →
linked article/homepage match, similarity ≥ 0.75) → article enrichment for a budgeted top slice
(`articleBudget: 25`) and homepage reachability checks (`homepageBudget: 30`) → 8-component weighted
ranking (`recency` 15, `event_strength` 20, `source_reliability` 10, `corroboration` 15, `domain` 10,
`young_company` 10, `stage_amount` 10, `novelty` 10 = 100 pts, every component logged with its raw value
and note) → two-track finalist selection: a **news track** (`finalists: 14`, lane/provider diversity
reservations capped at `maxLaneShare: 0.6`/`maxProviderShare: 0.4`, reservations floored at
`reserveMinScore: 50` so a diversity slot can't admit a very weak candidate, general fill down to
`minScore: 30`) and a **directory track** (`directoryFinalists: 25`, provider cap `0.6`).

**Evaluation methodology and results:** `src/eval/evaluate.ts` replays the whole funnel offline against
a committed snapshot fixture (`test/fixtures/snapshots/funnel-eval-2026-09-21`, 5 as-of days:
2026-09-02/04/17/19/21) and measures recall against 9 hand-labeled companies from the real Phase 1 live
discoveries (`src/eval/labels.ts`): 8 "primary" targets (Project-S, Fin.com, Empirik, Gaia Dynamics,
ScrollEd, TypeSafe AI, Aiir, Sunzu) plus heylogin tracked separately. Measured, regression-tested
(`test/eval.test.ts`) baseline: **raw lead 8/8, entity 8/8, finalist@14 6/8, finalist with the exactly
correct domain 3/8** (primary group); heylogin 0/1 (see below).

**Known limitations (disclosed, not silently accepted):**
- **Domain resolution is the weakest link** — 5 of 8 primary finalists still have no resolved domain,
  mostly Google-News-sourced entities whose URLs are unfetchable redirects with no linkable article.
- **Directory 25-slot cap under a larger pool** cost Sunzu its finalist slot (found correctly, under an
  *alt* domain `sunzu.ai` vs. the label's `sunzu.com`, but ranked below the cap).
- **Gaia Dynamics** is found, clustered, and ranked, but just outside the news top-14 (rank 18) — not a
  bug, just below the cutoff.
- **heylogin was never in any recorded source item on any of the 5 days** — a real source-coverage gap
  (likely outside the ~18-query Google News set and the RSS registry), not a filtering defect.
- **Techstars' single recorded snapshot** makes early as-of days (09-02/09-04) show `techstars-cohorts`
  as `empty` — the recorded cohort page's content reflects one point in time, so it can't simulate what
  the site looked like on earlier historical days. This likely **understates** what a real live daily
  run would see from Techstars.
- **False positives found on manual review** (top finalists across all 5 days were otherwise clean —
  real, corroborated funding/stealth/launch/accelerator evidence): one class-level gap was found and
  fixed (`angels?` added to the fund/investor-name filter in `src/funnel/prefilter.ts`, so an angel
  network announcing its own accelerator cohort is no longer mistaken for a portfolio company); two are
  disclosed but deliberately **not** patched, to avoid overfitting the filters to specific fixture
  headlines: an established consumer brand's marketing-campaign "launch" that carries no funding/young/
  mature signal either way, and a compound press-release headline (two verbs, one clause) that confuses
  deterministic subject extraction.

**Other real bugs fixed while finishing V2-1** (not accuracy tuning, correctness fixes): `src/sources/
fetcher.ts` and `src/http.ts` used a plain `AbortSignal.timeout()`, whose internal timer cannot be
cancelled and keeps the process alive for the full timeout even after the request completes;
`src/funnel-main.ts` called `process.exit()` immediately after a large `console.log(JSON.stringify(...))`
`--json` dump, which can truncate output on a piped consumer once it exceeds the OS pipe buffer.
Both fixed (see commit `3c1d5c6`); `src/main.ts` (Phase 1) has the same `process.exit()` pattern and
was flagged but intentionally left untouched (out of V2-1 scope, DB/schema-adjacent code is frozen).

**Remaining technical debt / open questions** (see §9 for what's next): no verification/escalation
stage exists yet — every funnel finalist today is an *unverified* deterministic candidate; domain
resolution needs a real strategy for redirect-only sources; the directory slot cap and the Google News
query set are both tuning targets, not obviously "right" yet.

---

## 5A. Current V2-2A state (Signal Foundation) — [BUILT]

A research phase (signal-intelligence design, not implemented) preceded this: it surveyed a wide
"signal universe" (hiring/ATS, GitHub, website structure, funding/regulatory, community, etc.) and
recommended a narrower first build. **V2-2A is that narrower build** — a foundation proving Startup
Radar can connect a company to reliable external sources, collect observations over time, and
derive deterministic, explainable signals from real *change*, not snapshots. It does **not**
replace or touch V2-1 (the discovery funnel is completely unchanged) and does **not** implement a
Radar/momentum score, alerts, watchlists, or comparison — those remain [PLANNED].

**New layer, new directory**: `src/signals/` — deliberately separate from `src/funnel/`/`src/sources/`
(V2-1 discovery) and from `src/db.ts` (V1 read-only reads). Conceptually:

```
COMPANIES (V2-1, unchanged) -> SOURCE RESOLUTION -> RAW OBSERVATIONS -> DETERMINISTIC COMPARISON -> DERIVED SIGNALS
```

**Two signal families only**: `hiring` (ATS job postings — Greenhouse/Lever/Ashby, all official
public no-auth APIs) and `github` (GitHub's official REST API). Website-structure monitoring, SEC
Form D, and every other family from the research report are explicitly **not** built yet.

**Source resolution** (`src/signals/resolution.ts`) is deterministic-first: it fetches a company's
own homepage (and, if nothing is found there, its `/careers` page — at most 3 requests per
company, ever) via the same `PoliteFetcher` V2-1 uses, looks for GitHub/ATS links, and only accepts
a candidate when either (a) the candidate's own public metadata confirms it back (a GitHub org's
`blog` field matching the company's domain, or an ATS board's own reported org name matching the
company name) — `resolution_method: "homepage_link_confirmed"` — or (b) no confirmation exists but
the slug/token closely resembles the company name (reusing V2-1's own `nameDomainSimilarity`) —
`"homepage_link_name_match"`, lower confidence. A candidate that is neither confirmed nor
name-similar is **rejected outright**, never stored: unresolved is the correct outcome when
evidence is insufficient, not a bug to work around. A bounded AI fallback for genuinely ambiguous
cases is architected (`src/signals/resolution-ai-fallback.ts`, modeled on the existing
`repairJson` pattern in `src/claude.ts`: reserve → timeout-scope → settle, cached, one call ever
per ambiguity) but is **not wired in anywhere** — a static guard test
(`test/readonly.test.ts`) asserts nothing in `src/signals/` calls it.

**Collectors** (`src/signals/sources/`): GitHub (stars, forks, open issues, contributor count,
trailing-4-week commit total, latest release date; `watchers` deliberately excluded — identical to
`stargazers_count` in the modern API, not a second signal) and the three ATS collectors (open job
count, per-category counts via a deterministic keyword classifier — `src/signals/sources/ats/
roles.ts` — and three narrow "notable first hire" booleans requiring a specific keyword *pair*,
e.g. `enterprise`/`strategic` **and** `account executive`/`sales`, matching the discipline
`src/funnel/extract.ts` already uses). No LLM anywhere in this path.

**Observation model** (`src/signals/types.ts`, DB tables applied — see below): one row per
(company, metric, time) in `observations`, never overwritten — the append-only raw-evidence layer.
`signals` are DERIVED and recomputable, each `rule_version`-stamped so a future threshold change
never silently reinterprets old history. `signal_sources` is the one mutable table (a resolution
can be corrected/deactivated later).

**Velocity/windows** (`src/signals/velocity.ts`): standard windows are 7/14/30/90 days;
`compareWindow` is strict — two observations 3 days apart never produce a "30-day" claim, and
a single observation reports insufficient history explicitly rather than guessing. A window
comparison only ever looks at its two endpoints (a mid-window spike that already reverted is
invisible by construction); `isPersistent` adds one more check for the case where the spike **is**
the latest reading — the move must already have been underway one reading earlier, not appear for
the first time in a single data point. See `rules/thresholds.ts` for every centralized, versioned
threshold (deliberately conservative starting values, not yet backtested).

**Database — additive only, applied**: `signal_sources`, `observations`, `signals` (full DDL,
grants, and a full change log are in the V2-2A delivery report, not duplicated here). RLS enabled,
zero policies, matching V1's posture exactly; `anon`/`authenticated` have **no** grants on any of
the three (Postgres/Supabase grants some baseline privileges to those roles on newly created tables
by default — this had to be explicitly revoked, the same way the original V1 migrations did for
`companies`/`discovery_events`). `service_role` gets SELECT/INSERT/UPDATE on `signal_sources`
(the one mutable table) and SELECT/INSERT-only on `observations`/`signals` (append-only, enforced
at the grant level, not just by convention). **`companies` and `discovery_events` were not
touched** — same columns, same constraints, same 10/10 row counts as before V2-2A.

**The one deliberate, narrow exception to "read-only"**: `src/signals/store.ts` is the *only* file
under `src/` allowed to write, and only `insert`/`upsert` into the three tables above — never
`companies`/`discovery_events`, never `update`/`delete` on `observations`/`signals`. This is
enforced by static guard tests in `test/readonly.test.ts`, not just a comment: one test scans all
of `src/` for write-capable calls outside that one whitelisted file, and a second test inspects
`store.ts` itself and asserts every `.from(...)` call names only `signal_sources`, `observations`,
or `signals`.

**Live-verified**: resolution + collection + storage were run against the real GitHub API and one
real company's real homepage (not just fixtures) before this was called done — see the delivery
report for exactly what was checked and what it found. Automated tests remain 100% offline (fake
fetch injection, no real network, no real Supabase, no Anthropic calls whatsoever).

---

## 5B. Current V2-2A.1 state (Automated Observation Runs) — [BUILT, CONFIGURED, LIVE]

Operationalizes V2-2A: a CLI that revisits known companies over time and a scheduled workflow to
run it unattended. Adds **no new signal families, no schema changes, no frontend changes** — it is
purely "run the existing V2-2A machinery safely, repeatedly, on its own." Three precise states,
never conflated: **BUILT** (the code exists and is tested) — true. **CONFIGURED** (the GitHub
Actions workflow is committed AND the required repository secrets exist) — true; the workflow is
committed on `main` (`1e15837`) and `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are set as repository
secrets. **LIVE** (a real scheduled or dispatched run has actually completed successfully in
Actions) — true; a manual `workflow_dispatch` run has completed successfully end-to-end.

**CLI** (`npm run signals`, `src/signals-main.ts`): argv/env/logging only — all policy lives in
`src/signals/orchestrate.ts`, which the CLI calls and nothing else. Flags: `--dry-run` (real
resolution/collection reads, zero writes), `--company <id|domain>`, `--limit <n>`, `--force`
(bypasses freshness — never the default), `--log-dir`, `--json`. Deliberately has **no** `--record`/
`--replay`: V2-2A's own fixture-based test suite already gives full offline reproducibility at the
unit/orchestration level, and building a second, CLI-level HTTP+DB snapshot system for this specific
milestone was judged not worth the added surface — a documented scope decision, not an oversight.

**Monitoring policy** (`src/signals/orchestrate.ts: runObservationPass`): serial, one company fully
at a time (only 10 companies today; correctness over speed). For each company: attempt resolution
**only** if it has zero active sources (never re-resolve an already-resolved source); for each
resolved/existing source, collect only if stale (see freshness below); derive signals from the
**full** accumulated history every time, deterministic rules unchanged from V2-2A. One company's or
one source's failure is caught and recorded, never stops the run — see "failure classification"
below.

**Freshness/cooldown** (`src/signals/freshness.ts`): centralized at **`COLLECTION_FRESHNESS_HOURS =
22`** — inside the requested 20-24h band, chosen to tolerate a scheduled job starting late (GitHub
Actions does not guarantee the exact cron minute) without ever allowing two collections in one
calendar day. Computed from `MAX(observed_at)` per source across existing `observations` — no new
column needed. `--force` bypasses this for manual testing; it is never the default and the
scheduled workflow never passes it.

**Resolution cooldown — a known, disclosed limitation, not a migration**: unlike collection
freshness, there is currently **no persisted record of a failed/unresolved resolution attempt** for
a company that still has zero sources (the schema has no place to store "we tried and found
nothing" without inventing a sentinel row against `signal_sources`' own CHECK constraints, which
would be a schema change — explicitly deferred per this milestone's brief). Practically: at the
intended once-daily cadence this is a small, bounded cost (≤3 requests to that company's own site
per day) and not a real politeness problem: but running the CLI manually many times in quick
succession WILL re-attempt resolution for every still-unresolved company each time, hitting their
real homepages/careers pages again each run. A future migration could add a
`last_resolution_attempt_at` column to close this gap; not built here.

**Missing vs. zero** (the non-negotiable rule from this milestone's brief): a metric absent from one
collection pass is UNKNOWN, never an implicit 0 — enforced structurally, not by a special case:
`observations` is one row per (company, metric, time), written **only** when a collector actually
obtained a value (a metric a collector couldn't retrieve is simply never pushed to its output — see
`src/signals/sources/github.ts`'s handling of a `202` "still computing" response). Nothing in the
observation/signal engine backfills, interpolates, or defaults a gap. `compareWindow`/
`bestAvailableWindow` (`src/signals/velocity.ts`) only ever see rows that were actually written, so
a gap is structurally invisible to them rather than needing to be filtered out. Proven by 7 explicit
regression tests (`test/signals-missing-vs-zero.test.ts`) covering exactly the scenarios the brief
named: missing previous/current metric, a newly-introduced metric, a temporarily-unavailable one
reappearing, a legitimate observed zero staying distinguishable from unknown, and a new metric never
corrupting an older, unrelated one's history.

**Failure classification** (per company: `resolution` = `not_attempted` | `resolved_new` |
`unresolved` | `no_supported_source` | `failed`; per source: `outcome` = `collected` |
`skipped_fresh` | `failed`): "no supported source found" and "a request actually failed" are kept
distinct on purpose — the former is a normal, expected outcome for most companies (most companies
don't use Greenhouse/Lever/Ashby or have a discoverable GitHub presence), the latter is a real
network/API problem worth noticing. Every company is wrapped in its own try/catch; every source
within a company is wrapped in its own try/catch — one failure never stops the rest.

**Signal dedup across runs** (`src/signals/dedup.ts`): application-level only, using
`(company_id, signal_type, to_observation_id)` as a natural key — the orchestrator reads existing
`signals` once per run and filters newly-derived ones against that key before inserting. This is
NOT a database-enforced constraint (that would be a schema change, deferred per this milestone's
brief); it is sufficient for a single serial CLI run, which is the only way this ever executes today.

**Reliability fix found during this milestone's own live validation** (disclosed, not hidden): the
very first live run of the new orchestrator hit a real transient database read failure. `SignalStore`
originally had no retry for reads (only writes had a hard deadline, no retries — deliberately, since
retrying a write without an idempotency key risks a duplicate row). Reads carry no such risk, so
`SignalStore`'s three read methods now retry up to 3 times with exponential backoff, matching
`src/db.ts: ReadOnlyDb#read`'s already-proven pattern exactly. Regression-tested.

**GitHub Actions** (`.github/workflows/signals.yml`): daily cron (`17 13 * * *` UTC — ~9:17 AM
EDT/8:17 AM EST, an off-the-hour time) plus `workflow_dispatch` for manual runs; `permissions:
contents: read` (least privilege); a concurrency group prevents overlapping runs; 15-minute job
timeout; `actions/checkout@v4` + `actions/setup-node@v4` (Node 24, matching `package.json`'s
`engines`) + `npm ci` + `npm run signals`. Uses the **built-in `GITHUB_TOKEN`** GitHub Actions
provisions automatically (confirmed: 1,000 requests/hour/repository, vs. 60/hour unauthenticated —
comfortably sufficient at this project's scale) — no separate personal access token was created.
**Required repository secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`** (same values as the
root `.env`, added as GitHub repository secrets, never committed). The workflow file's YAML was
validated and `npm ci` dry-run-verified against the committed lockfile, and a manual
`workflow_dispatch` run has since completed successfully in the Actions tab — this automation is
LIVE.

---

## 5C. Current V2-1.1 state (Automated Discovery Runs) — [BUILT, CONFIGURED, LIVE]

Operationalizes V2-1: a CLI that runs the existing deterministic discovery funnel unattended and
persists genuinely new companies. Adds **no new signal families, no new providers, no schema
changes, no frontend changes, no Radar Score** — it is purely "run the existing V2-1 funnel safely,
repeatedly, on its own, with a narrow write path." Discovery and signal observation (§5A/§5B) remain
fully separate systems and workflows; a company this milestone inserts becomes eligible for signal
observation automatically on that workflow's *next* run (via `ExistingIndex`/resolution — no direct
cross-invocation was built or is needed). Same three-state discipline as §5B: **BUILT** (code exists
and is tested) — true. **CONFIGURED** (workflow committed + secrets present) — true; the workflow is
committed on `main` (`aebebcb`) and reuses the `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` secrets
already set for §5B. **LIVE** (a real scheduled or dispatched run has completed successfully in
Actions) — true; a manual `workflow_dispatch` run has completed successfully in the Actions tab (in
addition to the earlier local live run against the real database, see below). A real scheduled
(cron) run has not fired yet — the workflow was only pushed to `main` today, before its 12:17 UTC
trigger time — but per the same standard already applied to §5B (a dispatched run is sufficient to
call an automation LIVE), that is not a blocker to this status.

**CLI** (`npm run discover`, `src/discover-main.ts`): argv/env/logging only — reuses the existing
V2-1 funnel (`runFunnel`, `ExistingIndex`, `PoliteFetcher`, homepage checker, `DEFAULT_FUNNEL_CONFIG`)
and persistence policy (`src/discovery/accept.ts`/`orchestrate.ts`/`store.ts`) unchanged, duplicating
none of it. Flags: `--dry-run` (runs the real funnel, zero writes), `--max-writes <n>` (may only
*lower* the built-in cap, never raise it — `--max-writes=-1` form required for negative-number
validation tests, a `util.parseArgs` quirk, not a CLI bug), `--log-dir`, `--json`, `--replay
<snapshot-dir>` + `--as-of <YYYY-MM-DD>` (offline reproduction against a committed HTTP snapshot;
replay always implies dry-run — there is no live database in that mode). The default production
command (no flags) is the one GitHub Actions runs, bounded entirely by the caps below.

**Acceptance rule** (`src/discovery/accept.ts: evaluateCandidate`): a finalist entity
(`RankedEntity.finalist === true`, which already encodes V2-1's prefilter + ranking + diversity
selection) with a **resolved domain** (`entity.domain.domain !== null`) is accepted; anything else is
rejected with a named reason (`not_finalist` | `unresolved_domain`). Deliberately minimal — no
threshold duplication, no re-scoring. An unresolved-domain candidate may appear in `--dry-run`/
`--json` output for visibility but is **never** inserted: "a wrong domain is worse than missing a
company for one run."

**Write policy** (`src/discovery/store.ts: DiscoveryStore`): `insertCompany` is a plain insert; a
`23505` unique-violation on `domain` is treated as a benign `{conflict: true}` (never thrown) since
the company already existing is an expected, non-error outcome — everything else throws. Existing
company fields are **never** overwritten; this milestone persists **new companies only** (see scope
cut below). `upsertEvents` is an ignore-duplicates upsert keyed on `(company_id, source_url)` — the
database constraint itself is the idempotency mechanism, not application logic. Both use the
established `#withDeadline` (a real `Promise.race`, not just an abort signal) and are attempted
**exactly once** — never blindly retried, since a write has no safe idempotency key for retry beyond
the DB's own constraints (matching `SignalStore`'s write policy in §5B).

**Scope cut, explicitly disclosed**: V2-1.1 persists brand-new companies (with their initial
events, from the same funnel run's evidence) only. It does **not** add new `discovery_events` rows
to an *already-existing* company when fresh corroborating evidence appears for it — a capability the
original brief explicitly permitted considering but left to be scoped in or out. Deferred to keep
the very first write path's blast radius minimal; a future milestone could add it without touching
this one's acceptance/write logic.

**Re-run idempotency across days** (no new state-tracking needed): `ExistingIndex` is built fresh
from live `companies` data on every invocation, so a company persisted today is naturally seen as
`existing` — not a new finalist candidate — on every subsequent run, via V2-1's own domain/name/alias
matching. No cross-run bookkeeping table was required.

**Hard run caps** (`src/discovery/limits.ts: DISCOVERY_LIMITS`, centralized): `maxAcceptedCandidates:
10`, `maxNewCompaniesPerRun: 5`, `maxNewEventsPerRun: 25`. The CLI's `--max-writes` may only lower
`maxNewCompaniesPerRun` for a given invocation, never raise or bypass any of the three. Zero new
companies is a valid, expected outcome on many runs — thresholds are never lowered to force a write.

**Failure isolation**: provider failures are isolated exactly as in V2-1 (per-provider try/catch,
health reporting, no single source failure aborting the run); a write failure for one candidate does
not stop the rest of the run (the last live run reported "0 failed writes," but the path exists and
is tested).

**Anthropic / external cost**: zero Anthropic calls, by code (the write-guard-style test asserting no
`.from()` call outside the two permitted tables, plus a direct grep-style check, cover
`src/discovery/orchestrate.ts`). All 10 existing V2-1 providers are reused unchanged; no new sources,
no paid APIs. Measured external cost on the one live run: **$0** (RSS/Atom/Google News/directory
fetches only).

**Controlled validation performed** (local, per the brief's mandated manual-first-run sequence):
(1) `--replay` against the committed V2-1 eval fixture, offline, no credentials — found and fixed two
real bugs during this step (see below); (2) real `--dry-run` against the live database — 5 candidates
reviewed manually, all judged legitimate; (3) **one** real live run, capped at `--max-writes=3`:
inserted 3 companies (Chamelio, Lightspring, Spott) and 17 discovery_events, 0 duplicates, 0 failed
writes, $0 external cost, 1.0s elapsed. Post-write verification confirmed `companies` went 10→13 and
`discovery_events` went 10→27, the three §5A/§5B signal tables were completely untouched (still
2/9/0), all three new domains are canonical and resolved, and every inserted event carries a real,
distinct `source_url` and headline — no fabrication.

**Two real bugs found and fixed during this validation** (disclosed, not hidden): (1)
`discoveryReasonFor` was pulling `round`/`amount_usd` from the entity-level best-evidence aggregate
instead of the *specific* evidence item being quoted, producing a real misattribution ("Nex joined an
accelerator cohort of $150M," borrowing a separate funding article's amount for an accelerator
listing that itself had none) — fixed to always use the primary evidence's own fields, with two
dedicated regression tests. (2) the dry-run branch of `runDiscoveryPass` set `events_inserted` on
each per-candidate result but never added it into the run-level summary total, so `--dry-run --json`
under-reported (`events_inserted: 0` despite real evidence) — fixed with the missing aggregation line
and a regression test.

**GitHub Actions** (`.github/workflows/discovery.yml`, committed on `main` — `aebebcb`): daily
cron (`17 12 * * *` UTC — one hour before the signals workflow's 13:17 UTC, so newly discovered
companies are already persisted before that pass runs; the ordering is a courtesy, not a hard
dependency) plus `workflow_dispatch`; `permissions: contents: read`; a concurrency group prevents
overlapping runs; 15-minute timeout; `actions/checkout@v4` + `actions/setup-node@v4` (Node 24) +
`npm ci` + `npm run discover` (no flags — the CLI's own built-in caps bound the run). **Required
repository secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`** only — both already exist (added
for §5B); no new secret was needed. No GitHub API access is needed at all for this workflow (unlike
§5B) since none of the 10 discovery providers touch `api.github.com`. A manual `workflow_dispatch`
run has completed successfully in the Actions tab; it found zero new companies that pass (a normal,
expected outcome — see the funnel's own "zero new companies is valid" design), leaving live counts
unchanged. The first real scheduled (cron) run has not occurred yet; nothing about the workflow
itself is in question — it's purely that today's 12:17 UTC trigger time had already passed before
the workflow was pushed.

---

## 5D. Current V2-2B.2 state (Website Structural Monitoring) — [BUILT, LIVE, COMPLETE]

Adds a third signal family — `website` — alongside `hiring`/`github` (§5A). Fully deterministic:
regex/heuristic page classification only, **no LLM, no browser rendering, no screenshots, no raw
HTML storage**. Builds on the append-only `observations`/derived-`signals` architecture from §5A
unchanged; no parallel history system was created.

**Source model**: exactly **one `signal_sources` row of `source_type: "website"` per company**,
identity = the company's own canonical `domain` (`resolution_method: "company_domain"`,
`resolution_confidence: 1`) — unlike GitHub/ATS, this needs **zero network requests to create**
(the domain is already known), so it is created unconditionally for every company, independent of
whatever else that company has.

**Five semantic page types tracked**, plus one homepage-level boolean:
`pricing`, `enterprise`, `security`/trust, `customers`/case-studies, `careers` (low corroboration
tier — see below), and `website_homepage_prelaunch` (waitlist/"coming soon" language on the
homepage). Pages are resolved deterministically from homepage nav links + `sitemap.xml` + a single
conventional-path probe per unresolved type, capped at **12 requests/company/pass** (typical
6–9): `src/signals/website/{resolve,patterns,robots,soft404,extract,fingerprint,source}.ts`.

**present / confirmed-absent / unknown — unknown is the default, never zero.** A page is only ever
written as `absent` (numeric `0`) when a real probe on a *navigable* (≥5 internal links), non-SPA,
English-or-unspecified-language homepage returns a genuine 404/410, a redirect back to the
homepage, or matches a soft-404 baseline (one deliberately bogus path fetched once per pass and
compared by title/H1). Anything short of that — a network failure, a block, a thin homepage, a
non-English site — stays **unknown**, and `src/signals/sources/website.ts` **never writes a row**
for an unknown page (identical discipline to the missing-vs-zero rule from V2-2B.1 — see §11).

**Derived signals** (`src/signals/rules/website.ts`):
- **One cold-start level signal**, `website_commercial_footprint_present_at_first_observation` —
  fires at most once, only from a company's first successful ("ok") pass, only when a NAMED
  combination is present (`enterprise_ready` = enterprise+security; `proven_commercial` =
  pricing+customers) — never a point/score system, and never worded as "appeared."
- **Six appearance-transition signals** — `website_pricing_page_appeared`,
  `website_enterprise_page_appeared`, `website_security_page_appeared`,
  `website_customer_proof_appeared`, `website_careers_page_appeared` (careers = low tier,
  `metadata.tier`), and `website_prelaunch_to_public` (a website-level view of stealth→public,
  worded around what the SITE showed — never claims the company was literally "in stealth"). Every
  appearance requires a **confirmed-absent baseline followed by two consecutive confirmed-present
  readings on the same `collection_version`**, and only the page's genuinely FIRST-ever appearance
  qualifies (later flapping never re-fires). **No removal/disappearance signals exist** —
  confirmed-absent rows are stored (useful to a future rule) but never turned into a "disappeared"
  signal; removal is far more ambiguous than appearance (redesign vs. real change) and was
  deliberately deferred, not overlooked.
- However many website signals fire for one company, they count as **exactly ONE** active
  corroboration family (`families.ts`'s existing distinct-family counting, unchanged) — the direct
  continuation of source-richness-bias prevention from V2-2B.1.

**Freshness — per-source-type, not the flat 22h github/ats cadence** (`src/signals/freshness.ts`):
**166h** normal cadence, **22h** while a page-state change is unconfirmed OR a fetch is transiently
failing (timeout/DNS/5xx), falling back to 166h after 3 consecutive failures. Computed from the
source's own `website_fetch_outcome` history — no new column. GitHub/ATS's flat 22h is untouched.

**Orchestrator fix (real bug, found and fixed before any live write)**: resolution eligibility used
to be gated on "this company has no active source of ANY kind" — since a website source needs no
network request and would be created for literally every company, that single flag would have
**permanently blocked GitHub/ATS resolution from ever running again** the moment website monitoring
shipped. Fixed to be per-source-class in `src/signals/orchestrate.ts`: the website source is
created whenever missing, independent of everything else; GitHub/ATS resolution is attempted
whenever a company has no *non-website* source yet, independent of whether its website source
already exists. 4 dedicated regression tests.

**Runs inside the existing daily `signals.yml` workflow** — no new GitHub Actions workflow, no new
schedule. `src/signals-main.ts` constructs a second, more conservative `PoliteFetcher` for website
requests only (~1s/host pacing, 15s timeout, 1MB cap) alongside the shared one GitHub/ATS already
use; `FetchResult` gained an additive `contentType` field, and the shared User-Agent
(`src/sources/fetcher.ts`, `src/http.ts`) now carries the project's repo URL as contact info.

**Migration — additive, applied and verified live** (`v2_2b2_website_monitoring_additive`):
`signal_sources.source_type` += `website`; `signal_sources.resolution_method` += `company_domain`;
`signals.family` += `website`; **`observations` gained a nullable `metadata jsonb` column, capped
at 4096 bytes** by a CHECK constraint (`observations_metadata_size`) — holds only small normalized
evidence (resolution method, path, final URL, status, truncated title/H1, verification checks,
language, nav-link count, `nav_fingerprint`), **never raw HTML/body text/screenshots**. Grants/RLS
unchanged (`service_role` stays append-only on `observations`/`signals`, SELECT/INSERT/UPDATE on
`signal_sources`; `anon`/`authenticated` still get nothing). `nav_fingerprint`
(`src/signals/website/fingerprint.ts`) is a SHA-256 of the normalized internal-link path set,
diagnostic-only — **no rule anywhere reads it**; a hash change is never itself a signal.

**Live-validated**: dry-run + one capped live write against 5 real companies (githits.com,
chamelio.ai, light-spring.com, spott.io, zeliq.com) before this was called done. Corrected page-state
totals across the 5 (25 = 5 companies × 5 types): **present = 9, absent = 10, unknown = 6**. One
real false positive was found during the dry-run and fixed *before* any write: a nav-link text match
on "case study" resolved a company's own engineering blog post as its `customers` (case-studies)
page — fixed by removing the bare "case study" text pattern (kept the stronger `/case-studies` path
pattern) and by rejecting any text-matched candidate whose path is nested under `/blog/` for every
page type; 4 regression tests added. The live write inserted 5 new `signal_sources`, 29 new
`observations`, and 5 new `signals` (3 GitHub-level signals for githits.com — its first-ever scored
pass, since `signals` had 0 rows before this milestone touched it — plus the commercial-footprint
level signal for both spott.io and zeliq.com). `companies`/`discovery_events` were not touched.

**Known limitations (disclosed, not silently accepted)**: robots.txt compliance was NOT retrofitted
to the pre-existing GitHub/ATS homepage-scanning resolution fetch (`src/signals/resolution.ts`) —
judged a larger, V2-2A-touching refactor than this milestone's scope, per the approved plan, and
deferred rather than risking that proven path. Conservative semantic matching means some real,
unusually-worded pages (a careers page that never says "open roles"/"hiring"/"join the team," for
one real example hit during validation) stay `unknown` rather than false-negative into "absent" or
falsely into "present" — a deliberate tradeoff, not a bug. No transition signal has fired from real
elapsed time yet (all 6 are unit-tested against synthetic multi-day histories; a genuine multi-day
observation hasn't had time to occur naturally). No domain-migration following (an off-domain
redirect is detected and left unresolved, never followed). No browser-rendering fallback for
JavaScript-heavy sites (a thin/SPA-shell homepage stays `unknown` across the board by design — see
the delivery report for the reasoning against adding one now).

---

## 6. AI / model philosophy

- **Deterministic code does the work whenever it practically can.** The entire V2-1 funnel — parsing,
  extraction, prefiltering, clustering, domain resolution, ranking — is 100% deterministic and makes
  **zero** Anthropic API calls. This is enforced by a static test
  (`test/funnel-v21.test.ts`/`test/eval.test.ts`: no `@anthropic-ai/sdk` import, no model name string,
  no prompt text anywhere under `src/funnel/`, `src/sources/`, `src/eval/`).
- **AI is reserved for tasks where it materially improves quality** that deterministic code genuinely
  cannot — not as a default. Concretely, that means disambiguation/verification of candidates the
  deterministic funnel has already found and ranked, not *finding* them in the first place.
- **[PLANNED, not built]** A cheap model (e.g. Haiku-class) for bounded triage/disambiguation over the
  funnel's finalists, and **[PLANNED, not built]** Sonnet reserved only for genuinely ambiguous or
  high-value cases the cheap pass can't resolve. Neither exists today — the funnel currently stops at
  ranking (§5).
- **No uncontrolled agentic web-search loops.** This is the specific thing V2 replaced (§4) and must
  not silently come back as "just a quick web search" inside a new feature.
- **Calls should be bounded and stateless where possible**: fixed per-candidate/per-request work,
  explicit timeouts (`src/deadline.ts`), no unbounded conversation state carried between calls.
- Today's only live model routing is Phase 1's `ModelRouter` (`src/models.ts`), default
  `claude-sonnet-5`, used for `discover`/`verify` stages, overridable via `SCOUT_MODEL` /
  `SCOUT_DISCOVERY_MODEL` / `SCOUT_VERIFY_MODEL`. It is not currently wired into the V2-1 funnel at all.

---

## 7. Cost and safety constraints

- **Intended daily operation is inexpensive/near-free**: the V2-1 funnel makes zero Anthropic calls and
  only read-only Supabase calls, so a live daily run costs effectively nothing today. Any future
  AI-triage stage must be designed to keep that property true (bounded, cheap-model-first, hard ceiling).
- **`$0.75` absolute per-run budget ceiling** (`ABSOLUTE_BUDGET_CEILING_USD`, `src/budget.ts`) applies to
  Phase 1's Anthropic usage. It reserves the pessimistic worst-case cost of a request *before* sending
  it, refuses anything that would exceed the remaining budget, and — once anything has been refused —
  refuses everything else for the rest of the run. This ceiling must never be raised without explicit
  approval, and any new call path that spends money must go through the same guard, not around it.
- **No accidental live Anthropic calls during tests/replay.** Every test runs against fakes/fixtures;
  `--replay` mode (both CLIs) never reads `.env`, never constructs a real API/DB client, and is verified
  by spawning the real CLI as a child process with every network primitive trapped
  (`test/fixtures/no-network.mjs`) and asserting zero attempts.
- **Snapshot/replay philosophy**: record real HTTP exchanges and a DB read once
  (`--record-snapshot`/`--record`), then replay deterministically offline forever after — this is how
  the whole test suite and the eval harness run without touching the network or spending money. Treat a
  snapshot fixture as load-bearing test data, not a scratch file.
- **Database-write protections**: no write-capable call exists anywhere under `src/` today — enforced by
  a static test (`test/readonly.test.ts`) that fails the suite if `.insert(`/`.update(`/`.upsert(`/
  `.delete(`/`.rpc(`, raw SQL write keywords, or `.storage` access appear anywhere, and confirms only
  `src/db.ts` imports `@supabase/supabase-js`, using only `.select()`. Do not weaken or delete this test.
  Corresponding V2-1 guards in `test/funnel-v21.test.ts`/`test/eval.test.ts` confirm the funnel code
  never touches a database client outside the live CLI branch.
- **Secrets handling**: credentials live only in `.env` (`ANTHROPIC_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`), which is gitignored; `.env.example` holds only empty placeholder names.
  `.mcp.json` is also gitignored and must never be committed. Never print, log, or echo a secret value —
  only presence checks and redacted output (`src/redact.ts`, applied to all log/artifact writes).
- **Rules future sessions must respect**: never raise the budget ceiling without approval; never add a
  database write path without explicit approval; never commit `.env` or `.mcp.json`; never remove a
  safety/guard test to make a change pass; never call live Anthropic APIs from an automated test.

---

## 8. Git / development workflow

- `main` is the current working branch (single-branch repo today: `main` only, tracking
  `origin/main` at `https://github.com/gradycwallen/startup-radar`). GitHub is the remote
  source-control backup.
- History so far: `d1af1ea` "Initial Startup Radar implementation" (the whole Phase 1 + V2-0 + V2-1
  codebase, committed in one pass after being built interactively), `3c1d5c6` "Complete V2-1" (the final
  V2-1 fixes described in §5). There is no CI workflow configured yet (`.github/` does not exist) —
  do not add one without being asked.
- Never commit `.env` or `.mcp.json` (both gitignored; verify `git status` before any commit if either
  file exists locally).
- Preserve existing tests and safety guards — do not delete or weaken a test to make a change pass; fix
  the change or get explicit sign-off on changing the guarded behavior instead.
- **Inspect the existing architecture before making structural changes.** This codebase has had several
  rounds of "build it, measure it, harden it" — re-read the relevant `src/` files and their tests before
  assuming a shortcut is safe.

---

## 9. Roadmap

| Phase | Status | Contents |
|---|---|---|
| Phase 1 (Claude-web discovery) | **[BUILT]** | Discovery via Claude `web_search`/`web_fetch`, verification, deterministic validation/dedup. Dry-run only, no write path. Timeout/shutdown hardening complete. Still present and functional, but no longer primary discovery. |
| V2-0 (safety/budget/audit foundation) | **[BUILT]** | Raw-lead ledger, `$0.75` budget guard + cost ledger, fatal-API-error abort, offline HTTP/DB snapshot+replay. |
| V2-1 (deterministic discovery funnel) | **[BUILT]** | RSS/Google-News/YC/Techstars providers, deterministic extraction/prefilter/clustering/dedup/domain-resolution/ranking, offline eval harness with measured recall. See §5. |
| Signal-intelligence research | **[DONE — research/design only]** | A wide survey of "momentum/behavioral" signals (hiring, GitHub, website structure, funding/regulatory, community, etc.) beyond V2-1's event signals, with feasibility notes and a prioritized recommendation. Superseded the originally-planned V2-2 scope below — see the delivery report for the full analysis. |
| V2-2A (Signal Foundation) | **[BUILT]** | The narrow first build from that research: source resolution + hiring (ATS) and GitHub observation collectors + a deterministic, versioned, explainable signal-derivation engine. No score, no alerts, no other signal families yet. See §5A. |
| V2-2A.1 (Automated Observation Runs) | **[BUILT, CONFIGURED, LIVE]** | Operationalizes V2-2A: `npm run signals` CLI, monitoring/freshness policy, failure isolation, and a GitHub Actions daily workflow (`17 13 * * *` UTC). Committed/pushed; secrets configured; a manual `workflow_dispatch` run has completed successfully. See §5B. |
| V2-1.1 (Automated Discovery Runs) | **[BUILT, CONFIGURED, LIVE]** | Operationalizes V2-1: `npm run discover` CLI, conservative acceptance/write policy, hard run caps, and a GitHub Actions daily workflow (`17 12 * * *` UTC, committed on `main`). One capped local live run (3 companies, 17 events, $0 cost) plus a successful `workflow_dispatch` run in Actions (0 new companies that pass — a valid outcome). See §5C. |
| V2-2B.2 (Website Structural Monitoring) | **[BUILT, LIVE, COMPLETE]** | Deterministic `website` signal family: one source/company, 5 semantic page types + pre-launch marker, present/absent/unknown, one cold-start footprint signal, 6 appearance-transition signals, no removal signals, additive migration applied, live-validated on 5 real companies. No AI, no browser rendering. See §5D. |
| V2-2B+ (SEC Form D, cross-family corroboration, a real score) | **[PLANNED, not yet scoped in detail]** | Website-structure monitoring (above) is now built. SEC Form D, cross-family corroboration, and eventually a transparent momentum/Radar score remain research-stage ideas, not committed plans — see the V2-2A delivery report's "what remains" section. Do not start any of it without explicit approval. |
| ~~V2-2 (Haiku triage / Sonnet escalation on funnel finalists)~~ | **superseded** | The originally-approved V2-2 scope (bounded AI triage/escalation directly on V2-1's funnel output) was reconsidered after the signal-intelligence research and replaced by V2-2A above. Entity-resolution AI fallback (a different, narrower idea) is architected in V2-2A but not implemented — see §5A. |
| V2-3 | **[not yet scoped]** | Not defined by the user at time of writing. Do not invent scope for it. |
| Controlled database writes to `companies`/`discovery_events` ("Phase 2") | **[BUILT, narrow scope — V2-1.1]** | `src/discovery/store.ts` writes new companies + their initial events only, under hard caps, via `npm run discover`. Does not (yet) add events to already-existing companies — see §5C. Any broader write scope still requires explicit approval. |
| Automation (scheduled runs) | **[LIVE for both signals and discovery]** | Two separate GitHub Actions workflows: `.github/workflows/signals.yml` (§5B, live, scheduled runs confirmed firing) and `.github/workflows/discovery.yml` (§5C, live via a successful `workflow_dispatch` run; first scheduled cron fire still pending — the workflow was pushed after today's trigger time). |
| Frontend / product | **[V1 BUILT + V2-3A BUILT]** | Radar feed, Explore, Company Detail, light/dark theme (V1), plus a Signal Intelligence section on Company Detail (V2-3A). Read-only against Supabase, no enrichment/watchlists/comparison/alerts, no signal score yet. See §10. |

---

## 10. Frontend / product direction

**Frontend V1 is built**, at `frontend/` — a separate Next.js (App Router) + TypeScript + Tailwind
app, decoupled from Scout (no discovery, no writes, no Anthropic calls; reads Supabase read-only via
a server-only client, service-role key never reaches the browser). See `frontend/README.md` to run
it. What V1 covers:

- **Radar (`/`)** — a recent-discoveries feed: search, category/signal-type/confidence/recency
  filters and sort, each company card showing its "why it's on the radar" reason (Scout's real
  `discovery_reason`, never fabricated).
- **Explore (`/explore`)** — a denser browse/search grid over the full company set, same filters.
- **Company Detail (`/companies/[id]`)** — identity, description, "why it's on the radar," and a
  full discovery-event timeline with sources — the evidence-transparency piece of the vision below.
- **Light/dark theme** — user-toggleable, persisted, respects OS preference on first visit, no flash.

What V1 deliberately does NOT do yet (see the delivery report for the reasoning): no invented
"Radar Score" or any other product-level score on the company page (removed after user review —
wait for a real backend-derived score before showing one); no enrichment fields (founders, HQ,
funding stage/investors, employee estimate, LinkedIn) — showing these as fabricated values for
real, identifiable seeded companies is out of bounds, so they simply aren't shown, not faked; no
watchlists, comparison, alerts, or search beyond simple substring matching.

The longer-term vision, still mostly ahead of V1: a polished startup/VC intelligence product, not an
AI-chatbot interface, built around a Radar feed, company profiles, discovery-event timelines,
evidence/source transparency, search/filtering, and "why this is on the radar" — matching the
transparency-first philosophy already in the backend's ranking breakdowns and lead ledger.

Frontend work is expected to **surface additional data requirements** (fields, aggregations, indexes)
that should feed back into Scout/schema decisions, rather than the backend speculatively expanding first
to guess what a UI will need. Let frontend needs drive schema changes — through the normal approval
process — rather than pre-building for it now.

**V2-3A (Signal Intelligence on Company Detail) — [BUILT]**. Adds a new Signal Intelligence section
to `/companies/[id]` — the first frontend surface for the `signal_sources`/`observations`/`signals`
data V2-2A/V2-2B built (§5A–§5D). Company-Detail-only: Radar, Explore, and Discovery Momentum
(`src/lib/derive/momentum.ts`, still `discovery_events`-only) are untouched, and the two systems are
kept visually and conceptually separate — the word "momentum" never appears in Signal Intelligence
copy. Section order: header → description → "why it's on the radar" → **Signal Intelligence** →
Discovery timeline.

New frontend modules: `frontend/src/lib/data/signals.ts` (a server-only, request-memoized read of
all three signal tables for one company — same posture as `data/companies.ts`: `.select()` only,
service-role key never reaches the browser) and `frontend/src/lib/derive/signal-view-model.ts` (the
presentation layer — turns raw `signal_type` strings into human titles via a lookup table plus a
humanizing fallback for anything unrecognized, never a switch statement in a component). Six new
components under `frontend/src/components/company/` (`signal-intelligence-section`,
`first-look-signal-card`, `transition-signal-card`, `signal-card-shell`, `signal-evidence`,
`coverage-line`, `family-badge`).

Preserves the backend's own semantics in the UI, not just the data: first-look ("cold-start") signals
get a "First observed" tag and state-only wording (title/evidence text is checked by test to never
say "appeared"/"increased"/"started"/"surged"); confirmed transitions show a compact
absent→first-observed→confirmed progression built only from real observation rows, never a
fabricated middle step. Evidence for a signal with only a `to_value` (every first-look level signal
— there is no prior reading to compare against) shows a single "X observed: N" row rather than
either omitting the number or inventing a "0 → N" comparison. Coverage is one line of plain text
(`Early evidence` / `Developing history · Tracked for N days` / `Longitudinal history · Tracked for
N days`, `· N signal families observed` appended only once real signals exist) — never a percentage,
bar, or score. Three distinct empty states (no sources resolved / sources but nothing fired yet / a
specific piece of evidence not yet determined), none using words like "missing"/"failed"/"none."

Zero schema/migration changes (confirmed against the live database before building). Frontend tests
added at `frontend/test/` (`node --test`, Node 24's native TypeScript execution — no new
dependency), covering the view-model layer's pure functions. Live-validated against the real
companies with signals (GitHits, Spott, Zeliq) and several with none.

---

## 11. Non-negotiables / do not break

- **Never make a live Anthropic API call from an automated test or from `--replay`/offline mode.**
- **Never add a database write path without explicit, current approval** — even a "harmless" one. The
  write-guard tests (`test/readonly.test.ts`) exist specifically to catch this by accident; do not
  delete, weaken, or work around them. There are exactly two write-capable files today, each guarded by
  a test that inspects every `.from(...)` call in that file by name and scopes it to specific tables:
  `src/signals/store.ts` (V2-2A — may only `insert`/`upsert` into `signal_sources`/`observations`/
  `signals`) and `src/discovery/store.ts` (V2-1.1 — may only `insert`/`upsert` into `companies`/
  `discovery_events`, never overwrite an existing company's fields, never `update`/`delete` either
  table). Do not add a third write-capable file, and do not let either file's writes cross into the
  other's tables or touch schema.
- **Never raise or bypass `DISCOVERY_LIMITS`** (`src/discovery/limits.ts`) from within `discover-main.ts`
  or `src/discovery/orchestrate.ts` — the CLI's `--max-writes` may only *lower* the company cap for a
  single invocation. Zero new companies is a valid outcome; never loosen the acceptance rule in
  `src/discovery/accept.ts` to force a write.
- **Never modify the `companies`/`discovery_events` schema, RLS, grants, or seed data** without the user
  explicitly asking. The 10/10 row counts are a fixed baseline other things (dedup tests, eval labels)
  are measured against. (`signal_sources`/`observations`/`signals`, added in V2-2A, are a separate,
  additive concern — that baseline doesn't apply to them, but they have their own posture: RLS on, zero
  `anon`/`authenticated` grants, append-only grants on `observations`/`signals`. Don't weaken that either.)
- **Never raise the `$0.75` absolute budget ceiling** (`ABSOLUTE_BUDGET_CEILING_USD`) without approval,
  and never let a new spending call path bypass `BudgetGuard`.
- **Never reintroduce unbounded/open-ended agentic web-search discovery loops** as a primary mechanism —
  that is precisely the cost/latency failure V2 replaced (§4).
- **Never commit `.env` or `.mcp.json`**, and never print/log/echo a raw secret value.
- **Never remove or shorten a wall-clock deadline** in `src/deadline.ts`/`src/config.ts`
  (`LIMITS`)/`src/funnel/funnel.ts` (`providerTimeoutMs`, etc.) without understanding why it exists
  (§4) — several were added in direct response to a real production hang.
- **Never add a raw, uncancelled `AbortSignal.timeout()`** for a network call — use the
  `setTimeout`+`AbortController`+`clearTimeout` pattern in `src/deadline.ts: timeoutScope` (or the local
  equivalents in `src/sources/fetcher.ts`/`src/http.ts`); a bare `AbortSignal.timeout()` leaks a
  process-keeping timer, discovered and fixed this session.
- **Don't start V2-2B+, V2-3, database writes to `companies`/`discovery_events`, or automation without
  explicit approval** — each is a distinct, separately-approved phase (§9). Frontend V1 exists (§10);
  further frontend features (enrichment, watchlists, comparison, alerts, a real backend-derived score,
  or surfacing V2-2A signals at all) still need approval too — V2-2A was built with NO frontend changes.
- **Never expose `SUPABASE_SERVICE_ROLE_KEY` to browser code.** In `frontend/`, only
  `src/lib/supabase/server-client.ts` (marked `import "server-only"`) may read it; never import that
  module, or reference the key, from a `"use client"` file.
- **Keep the funnel deterministic.** If you add anything under `src/funnel/`, `src/sources/`, or
  `src/eval/` that calls an LLM, you will fail the static guard test — that test is intentional, not a
  bug to route around. The same applies to `src/signals/`: its guard test asserts nothing there calls
  `resolveAmbiguousEntityWithAi` (the architected-but-unwired AI fallback in
  `src/signals/resolution-ai-fallback.ts`) — wiring it in is a deliberate future decision, not an
  oversight to "fix" by connecting it.
- **`src/signals/velocity.ts`'s strictness is deliberate, not overcautious.** Do not loosen
  `compareWindow` to accept a shorter gap than the requested window "close enough," and do not remove
  `isPersistent`'s check without understanding why (see §5A) — both exist specifically so a signal
  never overclaims a trend the data doesn't actually support.
- **A metric absent from an observation is UNKNOWN, never zero.** Do not add code anywhere in
  `src/signals/` that defaults a missing `numeric_value` to `0`, backfills a gap, or otherwise lets
  "we didn't observe this" become indistinguishable from "we observed zero" (§5B). This is the one
  rule the V2-2A.1 milestone treated as non-negotiable; it has 7 dedicated regression tests
  (`test/signals-missing-vs-zero.test.ts`) — do not weaken or delete them. **V2-2B.2 extends this
  to website page states**: an unresolved (unknown) page never gets a written `0` row — see §5D.
- **A website page transition requires a confirmed-absent baseline AND two consecutive confirmed-present
  readings on the same `collection_version`, and only the page's first-ever appearance qualifies.**
  Do not loosen this to a single reading or an unconfirmed change — see §5D and
  `src/signals/rules/website.ts: findFirstAppearance`. **Never add a website page-removal/disappearance
  signal** without explicit approval — this was deliberately deferred as more ambiguous than
  appearance, not overlooked.
- **A company's website source must never block, or be blocked by, its GitHub/ATS resolution.** See
  §5D's "orchestrator fix" — resolution eligibility in `src/signals/orchestrate.ts` is per source
  class (website vs. non-website), not "does this company have any source at all." Do not
  reintroduce a single combined eligibility check.
- **Never schedule the signals or discovery workflows more than once daily**, and never have either
  call `--force`/bypass its caps by default — both workflows' crons and each CLI's own defaults are
  deliberately conservative; loosening either is a decision for the user, not a default to change.
- **Do not claim a GitHub Actions automation is "live"** unless an actual scheduled or
  `workflow_dispatch` run has completed successfully in the Actions tab — a committed workflow file
  or configured secrets alone are "CONFIGURED," not "LIVE." See §5B/§5C's three-state distinction
  (true today for signals; not yet true for discovery).
- **Keep discovery (§5C) and signal observation (§5B) separate systems and workflows.** Do not make
  `discover-main.ts` invoke `signals-main.ts` or vice versa, and do not merge their GitHub Actions
  workflows — a newly discovered company becomes eligible for signal observation naturally, on that
  workflow's own next run, with no direct handoff code required or wanted.

---

## 12. Current project status

**Backend discovery**: V2-0 and V2-1 are both complete and pushed to `origin/main`. No live Anthropic
calls have been made by the V2-1 funnel at any point; Phase 1's Claude-web pipeline is present and
functional but is no longer the primary discovery path.

**Signal foundation**: V2-2A (§5A) is complete and committed/pushed (`34b6d16`) — `src/signals/`,
the three new tables (migration applied to the live database), tested, and live-verified against
the real GitHub API and one real company.

**Automated observation runs**: V2-2A.1 (§5B) is complete, committed/pushed (`1e15837`), and **LIVE**
— `src/signals-main.ts`, `src/signals/orchestrate.ts`/`freshness.ts`/`dedup.ts`,
`.github/workflows/signals.yml` (daily cron `17 13 * * *` UTC), repository secrets configured, and a
manual `workflow_dispatch` run has completed successfully end-to-end.

**Automated discovery runs**: V2-1.1 (§5C) is complete, committed/pushed (`aebebcb`), and **LIVE**
— `src/discover-main.ts`, `src/discovery/accept.ts`/`orchestrate.ts`/`store.ts`/`limits.ts`,
`.github/workflows/discovery.yml` (daily cron `17 12 * * *` UTC). Validated with one capped local
live run against the real database (3 companies, 17 events inserted, 0 duplicates, $0 external cost,
signal tables unaffected) and a successful `workflow_dispatch` run in the Actions tab (0 new
companies that pass — dedup correctly found nothing new to add, a valid outcome). The first real
scheduled cron run hasn't occurred yet — the workflow was pushed after today's 12:17 UTC trigger
time — but this is a timing fact, not an open item.

**Frontend**: V1 (§10) is built at `frontend/` and has been committed and pushed to `origin/main`
(`1fc56e8`) — build/typecheck/lint clean, verified against live Supabase data, light/dark theme
implemented and verified. Not touched by V2-2A, V2-2A.1, or V2-2B.2.

**Signal Intelligence frontend**: V2-3A (§10) is complete — a new Signal Intelligence section on
`/companies/[id]`, a server-only `signals.ts` data module, and a `signal-view-model.ts` presentation
layer, all built read-only against the existing `signal_sources`/`observations`/`signals` tables
(no schema change). Radar, Explore, and Discovery Momentum are untouched. Build/typecheck/lint/tests
clean; live-validated against real signal-bearing companies (GitHits, Spott, Zeliq) and several
zero-signal companies.

**Website structural monitoring**: V2-2B.2 (§5D) is complete — deterministic `website` signal
family, additive migration applied and verified live (`signal_sources.source_type` +=`website`,
`.resolution_method` +=`company_domain`, `signals.family` +=`website`, `observations.metadata jsonb`
capped at 4KB), the per-source-class resolution-eligibility fix, live-validated on 5 real companies
(one real false positive found and fixed before any write — see §5D). 528/528 tests passing,
typecheck clean, $0 external cost, zero Anthropic calls. Live DB counts after validation:
`companies=18`, `discovery_events=47`, `signal_sources=7`, `observations=38`, `signals=5`.

**Logical next decisions** (all require explicit user approval before any code is written):
1. Whether/how to scope the **remaining** V2-2B+ work — website-structure monitoring is now built
   (§5D); SEC Form D, cross-family corroboration, and a real transparent momentum score are still
   open, research-stage questions.
2. Whether to wire in the architected-but-unused AI entity-resolution fallback (§5A), and under what
   cost ceiling — deterministic resolution alone leaves some real companies' sources unresolved.
3. How to close the domain-resolution gap in V2-1's OWN funnel (5/8 primary finalists currently
   unresolved) — a separate, still-open item from before V2-2A, not superseded by it.
4. Whether to expand the Google News query set / RSS registry to close V2-1 coverage gaps like heylogin.
5. Whether/when a real backend-derived momentum/signal score should exist — V2-3A (§10) surfaced the
   raw signal data itself in the frontend; a score remains a separate, still-open decision.
6. Whether/when to extend V2-1.1 to also add new `discovery_events` to already-existing companies
   (explicitly scoped out of V2-1.1 itself — see §5C).
7. When to approve further **controlled database writes to `companies`/`discovery_events`** beyond
   V2-1.1's narrow new-companies-only path — see §11.

Note on this document's provenance: the repository's git history is thin (four commits as of V2-2A —
the project was built interactively and committed after the fact), so §4's "history and why" is
reconstructed primarily from code comments, the README, and this project's own prior working sessions
rather than from a granular commit log. Treat it as accurate to that history, but be aware the git log
itself won't independently corroborate the narrative.
