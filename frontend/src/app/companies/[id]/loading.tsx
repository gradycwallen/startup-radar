import { Skeleton } from "@/components/ui/skeleton";

// Mirrors the REAL single-column layout of companies/[id]/page.tsx (header -> description ->
// discovery-reason callout -> Signal Intelligence -> Discovery timeline). Previously this skeleton
// shaped a two-column sidebar layout the real page never had, so the loading state visibly snapped
// into a different shape the moment data arrived — fixed to match exactly.
export default function Loading() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <Skeleton className="h-4 w-16" />

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-6">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-4 w-20" />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
        <Skeleton className="h-4 w-32" />
      </div>

      <div className="mt-6 max-w-3xl space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>

      <Skeleton className="mt-6 h-20 w-full max-w-3xl rounded-lg" />

      <section className="mt-10 max-w-3xl">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="mt-2 h-4 w-full max-w-md" />
        <Skeleton className="mt-2 h-3 w-40" />
        <div className="mt-5 space-y-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      </section>

      <section className="mt-10 max-w-3xl">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-2 h-4 w-full max-w-sm" />
        <div className="mt-5 space-y-6 border-l border-line pl-6">
          <Skeleton className="h-20 w-full max-w-lg" />
          <Skeleton className="h-20 w-full max-w-lg" />
        </div>
      </section>
    </main>
  );
}
