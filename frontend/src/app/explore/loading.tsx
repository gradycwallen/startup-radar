import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-7xl px-6 py-10 sm:px-8 sm:py-16">
      <div className="max-w-2xl">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-11 w-full max-w-sm" />
        <Skeleton className="mt-5 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-5/6" />
      </div>

      <div className="mt-8 flex flex-col gap-4">
        <Skeleton className="h-9 w-full sm:max-w-sm" />
        <div className="flex flex-wrap gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-28" />
          ))}
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full rounded-lg" />
        ))}
      </div>
    </main>
  );
}
