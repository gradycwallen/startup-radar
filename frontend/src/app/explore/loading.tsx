import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-8">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-2 h-9 w-80 max-w-full" />
        <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      </div>
      {/* Mirrors the real full filter bar: a search+sort row, then the boxed segmented toolbar. */}
      <div className="mb-6 rounded-lg border border-line bg-surface/60 p-4">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <Skeleton className="h-9 w-full sm:max-w-xs" />
          <Skeleton className="h-9 w-full sm:w-40" />
        </div>
        <Skeleton className="mt-3 h-9 w-full sm:w-96" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full rounded-lg" />
        ))}
      </div>
    </main>
  );
}
