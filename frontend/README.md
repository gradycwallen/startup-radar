# Startup Radar — Web

The first user-facing frontend for Startup Radar: a read-only discovery-intelligence UI over the
companies and discovery events Scout (the backend, in the repo root) has found.

This app is intentionally decoupled from Scout: it never runs discovery, never writes to the
database, and never calls the Anthropic API. It only reads `public.companies` and
`public.discovery_events` from Supabase (or falls back to a clearly-labeled sample dataset — see
`src/lib/mock/companies.ts` — when no credentials are configured).

See the root [`CLAUDE.md`](../CLAUDE.md) for the whole project's context, and the frontend delivery
report (given to the user when this was built) for the product rationale, architecture decisions,
and recommended next steps.

## Setup

```bash
npm install
cp .env.local.example .env.local   # then fill in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
```

Both values are server-only (no `NEXT_PUBLIC_` prefix), read exclusively by
`src/lib/supabase/server-client.ts` (marked `import "server-only"`), and used for `SELECT` only.
Without them, every page still works — it renders the sample dataset instead, with a visible
banner saying so.

## Run

```bash
npm run dev
```

Open <http://localhost:3000>.

```bash
npm run build   # production build
npm run start   # serve the production build
npm run lint    # eslint
npx tsc --noEmit -p tsconfig.json   # typecheck (run `npx next typegen` first if routes changed)
```

## Structure

- `src/app/` — routes: `/` (Radar feed), `/explore` (browse/search), `/companies/[id]` (company
  detail), `/methodology` (how discovery/confidence/Momentum work), `/about` (the engineering
  writeup), `/api/companies` (a public JSON/CSV export of the current dataset).
- `src/components/` — `layout/` (header/nav/footer/page banner), `radar/`, `explore/`, `company/`
  (detail-page pieces: timeline, confidence badge, Signal Intelligence cards), `controls/` (the
  shared filter bar), `ui/` (small primitives: empty state, skeleton, count-up, data-source banner).
- `src/lib/data/` — the ONLY module that talks to Supabase (read-only), plus the domain types.
- `src/lib/supabase/` — the server-only Supabase client factory.
- `src/lib/mock/` — clearly-fictional fallback data, used only when Supabase isn't configured.
- `src/lib/derive/` — transparent, computed-not-fabricated presentation values (confidence tier,
  recency label, category color, Momentum — never a single hidden score, see `momentum.ts`).
- `src/lib/filters.ts` — shared search/filter/sort logic for the Radar and Explore pages.
