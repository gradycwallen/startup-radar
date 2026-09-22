import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Skeleton className="h-4 w-16" />
      <div className="mt-4 border-b border-line pb-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="mt-3 h-4 w-48" />
      </div>
      <Skeleton className="mt-6 h-16 w-full max-w-2xl" />
      <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="space-y-5">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </div>
    </main>
  );
}
