import { CompanyCardSkeleton } from "@/components/ui/skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2 h-9 w-96 max-w-full" />
        <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="mb-6 h-20 w-full rounded-lg" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <CompanyCardSkeleton key={i} />
        ))}
      </div>
    </main>
  );
}
