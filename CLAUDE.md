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
| V2-2B+ (remaining signal families, corroboration, a real score) | **[PLANNED, not yet scoped in detail]** | Website-structure monitoring, SEC Form D, cross-family corroboration, and eventually a transparent momentum/Radar score are all still research-stage ideas, not committed plans — see the V2-2A delivery report's "what remains" section. Do not start any of it without explicit approval. |
| ~~V2-2 (Haiku triage / Sonnet escalation on funnel finalists)~~ | **superseded** | The originally-approved V2-2 scope (bounded AI triage/escalation directly on V2-1's funnel output) was reconsidered after the signal-intelligence research and replaced by V2-2A above. Entity-resolution AI fallback (a different, narrower idea) is architected in V2-2A but not implemented — see §5A. |
| V2-3 | **[not yet scoped]** | Not defined by the user at time of writing. Do not invent scope for it. |
| Controlled database writes ("Phase 2") | **[PLANNED, not started]** | Writing accepted companies/events to `companies`/`discovery_events`. Requires explicit approval; no write path exists in code today, and the DB schema is frozen until then. |
| Automation (scheduled runs) | **[PLANNED, not started]** | E.g. a scheduled daily run. Explicitly deferred — no GitHub Actions workflow or other scheduler exists; do not create one without being asked. |
| Frontend / product | **[V1 BUILT]** | Radar feed, Explore, Company Detail, light/dark theme. Read-only against Supabase, no enrichment/watchlists/comparison/alerts yet. See §10. |

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

---

## 11. Non-negotiables / do not break

- **Never make a live Anthropic API call from an automated test or from `--replay`/offline mode.**
- **Never add a database write path without explicit, current approval** — even a "harmless" one. The
  write-guard tests (`test/readonly.test.ts` and the V2-1 equivalents) exist specifically to catch this
  by accident; do not delete, weaken, or work around them. The one existing exception
  (`src/signals/store.ts`, V2-2A) is itself guarded: it may only `insert`/`upsert` into
  `signal_sources`/`observations`/`signals`, checked by a test that inspects every `.from(...)` call
  in that file by name. Do not add a second write-capable file, and do not let that one file's writes
  reach `companies`/`discovery_events`, `update`/`delete` `observations`/`signals`, or touch schema.
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

---

## 12. Current project status

**Backend discovery**: V2-0 and V2-1 are both complete and pushed to `origin/main`. No live Anthropic
calls have been made by the V2-1 funnel at any point; Phase 1's Claude-web pipeline is present and
functional but is no longer the primary discovery path.

**Signal foundation**: V2-2A (§5A) is complete — `src/signals/`, the three new tables (migration
applied to the live database), tested, and live-verified against the real GitHub API and one real
company. Not yet committed/pushed as of this writing; see the delivery report for the exact state.

**Frontend**: V1 (§10) is built at `frontend/` and has been committed and pushed to `origin/main`
(`1fc56e8`) — build/typecheck/lint clean, verified against live Supabase data, light/dark theme
implemented and verified. Not touched by V2-2A.

**Logical next decisions** (all require explicit user approval before any code is written):
1. Whether/how to scope **V2-2B+** — which remaining signal families (website-structure monitoring,
   SEC Form D, others from the research report) to build next, if any, and when cross-family
   corroboration and a real transparent momentum score are worth attempting.
2. Whether to wire in the architected-but-unused AI entity-resolution fallback (§5A), and under what
   cost ceiling — deterministic resolution alone leaves some real companies' sources unresolved.
3. How to close the domain-resolution gap in V2-1's OWN funnel (5/8 primary finalists currently
   unresolved) — a separate, still-open item from before V2-2A, not superseded by it.
4. Whether to expand the Google News query set / RSS registry to close V2-1 coverage gaps like heylogin.
5. Whether/when V2-2A's signals should be surfaced in the frontend at all (a "Signals" panel was
   explicitly out of scope for V2-2A) and whether/when a real backend-derived score should exist.
6. When to approve **controlled database writes to `companies`/`discovery_events`** ("Phase 2") — still
   not implemented anywhere in code. (V2-2A's writes to the three new signal tables are a separate,
   narrower, already-approved exception — see §11.)

Note on this document's provenance: the repository's git history is thin (two commits total — the
project was built interactively and committed after the fact), so §4's "history and why" is
reconstructed primarily from code comments, the README, and this project's own prior working sessions
rather than from a granular commit log. Treat it as accurate to that history, but be aware the git log
itself won't independently corroborate the narrative.
