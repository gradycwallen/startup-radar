# Startup Radar frontend

The Next.js frontend presents companies, discovery events, observations, and signals collected by the backend. It reads from Supabase; it does not run discovery or write to the database.

## Setup

Use Node.js 24 or newer:

```bash
npm ci
npm run dev
```

Open the local address printed in the terminal. With no Supabase credentials, the app uses a labeled sample dataset. Signal data and aggregate counts that aren't available in the sample are not invented.

To connect a database, copy `.env.local.example` to `.env.local` and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Both values are used server-side. Keep the service-role key private and never add it to a `NEXT_PUBLIC_` variable or commit it.

## Checks

```bash
npm test
npm run lint
npm run build
```

## Where to look

- `src/app/`: Radar, Explore, company profiles, Methodology, About, and the company export API.
- `src/components/`: page and shared UI components.
- `src/lib/data/` and `src/lib/supabase/`: server-side data access.
- `src/lib/mock/`: sample data for running without credentials.
- `src/lib/derive/` and `src/lib/filters.ts`: presentation values, filtering, and sorting.

See the [root README](../README.md) for the project story and pipeline overview.
