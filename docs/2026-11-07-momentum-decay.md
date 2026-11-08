# Momentum decay / staleness detection — November 7, 2026

A read-only analysis (`src/analysis/staleness.ts`, `npm run analyze:staleness`) — the inverse of
everything else built this session. Corroboration and the lead-time backtest both ask "did
something happen." This asks "did it **stop** happening" — a company with real early activity and
silence ever since is a genuine, VC-relevant observation nothing else in this project surfaces.

## Method

For every company with at least one signal ever fired (any family — hiring, GitHub, website),
find the most recent `fired_at` across all of them combined, and bucket the gap to now:

- **active** — ≤14 days since the last signal
- **cooling** — ≤45 days
- **stalled** — >45 days

Companies with **zero** signals ever are excluded entirely, not counted as "stalled" — that's an
unresolved-tracking question (see `docs/2026-11-07-corroboration-lead-time.md`), a different thing
from a company that was once active and has since gone quiet. Thresholds are centralized in
`STALENESS_THRESHOLDS`, conservative starting values, not yet backtested — same disclosed posture
as every other threshold in this codebase (`src/signals/rules/thresholds.ts`).

7 offline tests (`test/staleness.test.ts`) cover the bucket boundaries exactly, that only the most
recent signal across *all* families determines the bucket (not any one family in isolation), sort
order, and the zero-signal exclusion.

## Live result (2026-11-07)

```
Companies with at least one signal ever:  32
  active  (<=14d since last signal):  20
  cooling (<=45d since last signal):  10
  stalled (>45d since last signal):   2

Stalled companies (longest-silent first):
    46d  Spott (id 13) — last signal 2026-09-22
    46d  Zeliq (id 16) — last signal 2026-09-22
```

Both stalled companies last fired a signal on 2026-09-22 — consistent with being part of the
original V2-2B.2 website-monitoring validation batch (`CLAUDE.md` §5D), not evidence of anything
unusual on its own. Worth re-running once more companies have accumulated longer real histories;
with only 32 companies evaluated and the project ~7 weeks old, this is a small, early sample.
