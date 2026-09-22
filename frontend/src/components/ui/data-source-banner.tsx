import type { DataSource } from "@/lib/data/types";

/**
 * Visible flag whenever the page is showing the mock/sample fallback dataset instead of live
 * Supabase data — so sample data is never mistaken for real discovery intelligence. Renders
 * nothing when the source is "supabase". See src/lib/mock/companies.ts.
 */
export function DataSourceBanner({ source }: { source: DataSource }) {
  if (source === "supabase") return null;
  return (
    <div className="mb-6 flex items-center gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200">
      <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" />
      <p>
        <span className="font-medium">Sample data.</span> No Supabase connection configured for this environment — showing
        illustrative, fictional companies. Add credentials to <code className="rounded bg-amber-100 px-1 py-0.5 text-[0.85em] dark:bg-amber-400/15">frontend/.env.local</code> to see live discoveries.
      </p>
    </div>
  );
}
