import clsx from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded bg-line/70", className)} />;
}

// Matches the real CompanyCard's shape (radar/company-card.tsx): a borderless row — no card
// border/background of its own, since real rows are separated by the parent's `divide-y` — with a
// logo circle, name/domain line, confidence badge top-right, a description line, tag row, and a
// momentum line. Kept in sync so the loading state doesn't visibly snap into a different shape.
export function CompanyCardSkeleton() {
  return (
    <div className="px-6 py-6 sm:px-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 gap-3.5">
          <Skeleton className="h-10 w-10 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
        </div>
        <Skeleton className="h-4 w-20 shrink-0" />
      </div>
      <Skeleton className="mt-4 h-4 w-2/3" />
      <div className="mt-4 flex gap-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-16" />
      </div>
      <Skeleton className="mt-3 h-4 w-32" />
    </div>
  );
}
