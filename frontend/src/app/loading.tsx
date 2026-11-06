import { CompanyCardSkeleton } from "@/components/ui/skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-7xl px-6 py-10 sm:px-8 sm:py-16">
      <div className="max-w-2xl">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-3 h-11 w-full max-w-md" />
        <Skeleton className="mt-2 h-11 w-2/3" />
        <Skeleton className="mt-5 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-5/6" />
      </div>

      <div className="mt-14 flex flex-wrap gap-x-12 gap-y-5 border-t border-line pt-7">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-10 w-14" />
          </div>
        ))}
      </div>

      <div className="mt-14 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-9 w-full sm:max-w-sm" />
        <Skeleton className="h-6 w-32 shrink-0" />
      </div>

      <div className="mt-8 divide-y divide-line">
        {Array.from({ length: 6 }).map((_, i) => (
          <CompanyCardSkeleton key={i} />
        ))}
      </div>
    </main>
  );
}
