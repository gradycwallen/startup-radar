import clsx from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded bg-line/70", className)} />;
}

export function CompanyCardSkeleton() {
  return (
    <div className="rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <Skeleton className="h-5 w-20 shrink-0" />
      </div>
      <Skeleton className="mt-3 h-4 w-2/3" />
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-20" />
      </div>
    </div>
  );
}
