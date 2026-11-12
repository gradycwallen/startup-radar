import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-[1040px] px-6 pb-16 pt-14 sm:px-8 sm:pt-20" aria-label="Loading companies">
      <div className="grid gap-7 border-b border-line-strong pb-10 md:grid-cols-[1.5fr_1fr] md:items-end md:gap-16 md:pb-14">
        <div><Skeleton className="h-3 w-40" /><Skeleton className="mt-5 h-16 w-4/5 sm:h-24" /><Skeleton className="mt-2 h-16 w-full sm:h-24" /></div>
        <div><Skeleton className="h-5 w-full" /><Skeleton className="mt-3 h-5 w-4/5" /><Skeleton className="mt-3 h-5 w-2/3" /></div>
      </div>
      <div className="grid grid-cols-2 border-b border-line sm:grid-cols-3 lg:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="py-6"><Skeleton className="h-3 w-24" /><Skeleton className="mt-2 h-8 w-16" /></div>)}</div>
      <div className="mt-10"><Skeleton className="h-3 w-24" /><Skeleton className="mt-2 h-9 w-64" /><Skeleton className="mt-10 h-10 w-full" />{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="mt-4 h-16 w-full" />)}</div>
    </main>
  );
}
