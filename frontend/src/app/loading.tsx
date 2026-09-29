import { CompanyCardSkeleton } from "@/components/ui/skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-8">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2 h-9 w-96 max-w-full" />
        <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      </div>
      {/* Matches the Radar page's compact filter bar (search + sort, no boxed panel) — the boxed
          panel this used to skeleton no longer exists here; see /explore for the full toolbar. */}
      <div className="mb-6 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <Skeleton className="h-9 w-full sm:max-w-xs" />
        <Skeleton className="h-9 w-full sm:w-40" />
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <CompanyCardSkeleton key={i} />
        ))}
      </div>
    </main>
  );
}
