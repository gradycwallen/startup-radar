import { Skeleton } from "@/components/ui/skeleton";

// Mirrors the real single-column layout of companies/[id]/page.tsx (header -> description ->
// discovery-reason callout -> Signal Intelligence -> Discovery timeline) at its current container
// width, so the loading state doesn't visibly snap into a different shape once data arrives.
export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10 sm:px-8 sm:py-16">
      <Skeleton className="h-4 w-16" />

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-8">
        <div className="flex gap-5">
          <Skeleton className="h-14 w-14 shrink-0 rounded-md" />
          <div>
            <Skeleton className="h-9 w-56" />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
        </div>
        <Skeleton className="h-4 w-32" />
      </div>

      <div className="mt-8 max-w-2xl space-y-2">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-5/6" />
      </div>

      <Skeleton className="mt-8 h-20 w-full max-w-2xl rounded-lg" />

      <section className="mt-14 max-w-3xl">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="mt-2 h-4 w-full max-w-md" />
        <Skeleton className="mt-3 h-3 w-40" />
        <div className="mt-6 space-y-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      </section>

      <section className="mt-14 max-w-3xl">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="mt-2 h-4 w-full max-w-sm" />
        <div className="mt-6 space-y-6 border-l border-line pl-6">
          <Skeleton className="h-20 w-full max-w-lg" />
          <Skeleton className="h-20 w-full max-w-lg" />
        </div>
      </section>
    </main>
  );
}
