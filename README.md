# Startup Radar Scout

Discovers emerging startups from current public web information, verifies them, de-duplicates
against Supabase, and (in a later phase) stores the company and its discovery event.

> **Phase 1: dry-run only.** The code has no database write path at all. `--write` is refused, and a
> test (`test/readonly.test.ts`) fails if any insert/update/upsert/delete/rpc call appears under `src/`.

## Pipeline

```
DiscoveryProvider -> raw leads -> verification -> deterministic validation -> deduplication -> (Phase 2: writes)
```

| Stage | File | Notes |
|---|---|---|
| Providers | `src/providers/` | `DiscoveryProvider` interface; V1 has one: `claude-web` (Claude `web_search`/`web_fetch`, one call per lane) |
| Verification | `src/verify.ts` | `Verifier` interface; `ClaudeVerifier` returns a structured, evidence-backed claim |
| Validation | `src/validate.ts` | Deterministic: domain, source URL provenance, event type, dates, eligibility, confidence caps, homepage check |
| Deduplication | `src/dedupe.ts` | Domain, then `(company, normalized source_url)`, then same-underlying-event heuristics |
| Database | `src/db.ts` | Read-only `select`s and counts |
| Model choice | `src/models.ts` | `ModelRouter`; default `claude-sonnet-5`. Swap routing here to send ambiguous cases to a stronger model |

To add a provider (news feed, accelerator list, GitHub, Product Hunt, ...): implement `DiscoveryProvider`
and register it in `src/main.ts`. Nothing downstream changes.

## Setup

```bash
npm install
cp .env.example .env     # then fill in the three values; .env is gitignored
```

| Variable | Where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Console |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard -> Project Settings -> API. Server-side only. Never commit it. |

## Run

```bash
npm run scout -- --dry-run                       # full dry run
npm run scout -- --dry-run --lanes funding,stealth --max-candidates 8
npm run scout -- --help
npm test
npm run typecheck
```

Each run writes `logs/<run-id>.jsonl` (every decision) and `logs/<run-id>.summary.json`, and records
Supabase row counts before and after to prove nothing changed.

Environment overrides: `SCOUT_MODEL`, `SCOUT_DISCOVERY_MODEL`, `SCOUT_VERIFY_MODEL`.

## Reliability limits (Phase 1 hardening)

The Anthropic SDK's own timeout only covers the wait for response headers, so a streamed request could
stay open indefinitely. Every wall-clock limit below is enforced by us with abort signals, and aborting
also cancels SDK retry waits (a huge `Retry-After` cannot hold a request past its deadline). Values live in
`LIMITS` in `src/config.ts`.

| Scope | Limit | On expiry |
|---|---|---|
| One discovery request (whole stream) | 6 min | request timeout; lane marked failed |
| One verification request (whole stream) | 5 min | request timeout; candidate marked `timeout` |
| SDK pre-header wait (per attempt) | 60 s | `header` timeout after SDK retries |
| JSON repair call | 60 s | request timeout |
| One discovery lane | 9 min | lane `timeout`; next lane still runs |
| One candidate verification | 7 min | candidate `timeout`; others continue |
| One Supabase read (retries included) | 15 s | `db_read_timeout` logged; see below |
| Whole run (soft) | 45 min | stop STARTING new lanes/candidates; in-flight work finishes under its own limits |

Lanes run serially. `web_fetch` is capped at 20,000 content tokens per fetch; search/fetch counts per request
are unchanged (discovery 6/3, verification 4/5).

Every timeout is logged with what timed out (`kind`, `label`), the limit, elapsed time, the request id and the
web operations still pending. Each web operation is timestamped (`web_op` events), and each request logs stream
timing (`max_gap_ms`) to choose a future idle-stream threshold from evidence. SDK retries are logged as
`sdk_retry`; all log output is redacted for secrets.

**Database reads:** each read has a 15 s wall-clock deadline (the request is aborted and never retried after a
timeout). The starting row count is required, so a timeout there fails the run before any Anthropic spend. The
optional duplicate pre-check just logs and continues to verification. De-duplication is required for
correctness, so a timed-out read fails that candidate, and later candidates fail fast (`dedupe_skipped`) instead
of each waiting 15 s. The final row count is best-effort (`rows_after: null` if unavailable).

**Shutdown:** SIGINT/SIGTERM aborts in-flight Anthropic work, starts nothing new, writes a partial
`*.summary.json` (`status: "interrupted"`), and exits 130/143. A second signal exits immediately.

## V2-0: audit trail, cost control and offline replay

Per-run artifacts in `--log-dir` (default `logs/`), all redacted and written as they happen:

| File | Contents |
|---|---|
| `<run>.leads.jsonl` / `.leads.json` | **Every raw lead** (name/title, source URL, provider/lane, domain hint, timestamps, stage reached, final disposition or drop reason). Written the moment a lane finishes, before selection. |
| `<run>.cost.jsonl` / `.cost.json` | Every Anthropic request: worst-case **estimate**, **actual** usage/cost where reported, outcome, request id. |
| `<run>.summary.json` | Run summary, now including `cost`, `lead_ledger`, `fatal_error`, `mode`. |

**Fatal API errors** (insufficient credit, authentication, permission) abort all remaining Anthropic work at once,
produce a partial summary with `status: "failed"`, and exit **4**. A `$0.75` **budget guard** refuses any request whose
worst-case estimate could exceed the remaining budget, before it is sent (exit **5** if that stops the run).
Exit codes: 0 ok, 1 failed, 2 usage, 3 database changed, 4 fatal API error, 5 budget ceiling, 130/143 signals.

**Offline replay** (`--replay <snapshot dir>`) re-runs the pipeline from recorded data with no credentials, no
Anthropic calls, no live sources and no database; it never reads `.env`. `--record-snapshot <dir>` saves a snapshot after
a live run. See `src/snapshot.ts` and `test/fixtures/snapshots/`.

## Rules the scout enforces

- Minimum confidence to accept: 0.75 (entity, domain, evidence and event correctness; never investment quality).
- Event types: `funding`, `product_launch`, `accelerator`, `news`, `open_source`, `stealth`.
- Every event requires a `source_url` that was actually retrieved during the run.
- Domains are normalized to the registrable domain before any comparison.
- `founded_year` is stored only when evidenced; otherwise NULL. Unknown year is allowed with early-stage evidence.
- Max accepted new companies per run: `--max-new` (default 10).
- The scout never deletes and (Phase 1) never writes.
