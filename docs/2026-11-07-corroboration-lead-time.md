# Corroboration lead-time — November 7, 2026

A read-only analysis over the live database (`src/analysis/corroboration.ts`, `npm run
analyze:corroboration`). No writes, no Anthropic calls. Fully covered offline by
`test/corroboration.test.ts` (7 tests, pure-function, fixture data only — this report's numbers
come from a separate live run against Supabase, not from the test suite).

## The question

Once Scout discovers a company via a funding announcement, how often — and how fast — does the
Signal Intelligence layer (hiring, GitHub, website observation) independently back that up with
evidence from a completely different source family?

This is **not** the originally-proposed "did a signal predict a *subsequent* funding round"
backtest. That needs a company that was already tracked and then had a second, later, separately
detected funding event — and V2-1.1 (`src/discovery/*`) explicitly never adds a new
`discovery_events` row to an already-existing company (see `CLAUDE.md` §5C, "Scope cut, explicitly
disclosed"). No such pair exists in the data yet, by design, not by accident. What follows is the
closest honest question the current data can answer.

## Result (live, 2026-11-07)

```
Companies discovered via a funding event:        147
  ...with at least one resolved signal source:   147
  ...of those, ever corroborated by a signal:    25 (17.0%)

Lead time to first corroborating signal (days from discovery):
  median: 2.1   mean: 10.9   min: 0   max: 43.1

First corroborating signal, by family:
  hiring  : 7
  github  : 3
  website : 15
```

All 147 funding-discovered companies have at least one resolved signal source (every company gets
an unconditional `website` source — see `CLAUDE.md` §5D — so this number is expected to be ~100%
and isn't itself informative). Of those, **25 (17%) have had at least one signal fire** from
hiring, GitHub activity, or website observations. These include first-look signals as well as
changes over time; they do not all establish that activity changed after discovery.

## Reading this honestly

- **17% is a low rate, and that's expected, not a defect.** Most companies here were discovered in
  the last few weeks (`CLAUDE.md` §12: the project has been live since 2026-09-21). Signal
  derivation requires either a strong first-look reading (a "level" signal) or two independent
  observations spaced far enough apart for a real window comparison (7/14/30/90-day windows — see
  `src/signals/velocity.ts`). A company observed for the first time 4 days ago cannot yet qualify
  for most of these checks, regardless of whether anything real happened.
- **The median (2.1 days) and mean (10.9 days) diverging this much points to a skewed
  distribution, not a typical company.** A handful of companies with long gaps (up to 43.1 days)
  are pulling the mean up; most corroborating signals that do fire, fire fast. The median is the
  more representative number here.
- **Website leads (15 of 25).** Consistent with `CLAUDE.md` §5D: a website source needs zero
  network requests to create (it's just the company's own canonical domain) and can produce a
  cold-start "commercial footprint present" signal from a single pass, while GitHub/ATS sources
  require a resolution step first and GitHub's own velocity signals need real elapsed time between
  readings.
- **This measures the system's own responsiveness, not predictive power.** A high corroboration
  rate would mean "Scout's signal layer reliably catches up with evidence once it starts tracking
  a company" — a real, useful property, but a different claim than "Scout saw this coming before
  anyone else." The predictive version of this question is still blocked on the §5C scope cut
  described above.

## What would make this a stronger result

1. **More elapsed time.** This dataset is ~7 weeks old; most companies haven't had enough calendar
   time for the slower velocity windows (30/90-day) to even become eligible. Re-running this in a
   month will be a meaningfully different, more trustworthy number.
2. **The real predictive backtest** (lead time before a *subsequent* round), which needs discovery
   extended to add new `discovery_events` to already-existing companies — a larger, write-path
   change that's out of scope here and needs its own explicit approval per `CLAUDE.md`'s
   non-negotiables.

## The real backtest, built and run (also 2026-11-07)

`src/analysis/lead-time-backtest.ts` / `npm run analyze:lead-time` is the actual predictive
question from above: for a company with a genuinely *separate, later* funding round (not just
several articles about the same raise — event dates are clustered with a 14-day gap threshold so
same-week corroboration doesn't get mistaken for a second round), did a hiring/GitHub/website
signal fire between the two, and how far in advance?

Live result:

```
Companies with 2+ funding events on record:          128
  ...clustering into 2+ genuinely separate rounds:   0
```

Zero companies cluster into a genuine second round — confirming, with a real general-purpose tool
rather than a one-off query, that no qualifying pair exists yet. The tool is fully built and tested
(`test/lead-time-backtest.test.ts`, 7 offline tests) and will report real numbers the moment either
of the two conditions above is met — nothing further needs to be written when that happens.
