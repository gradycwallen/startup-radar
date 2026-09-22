"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import type { CompanyFilters, SortKey } from "@/lib/filters";
import { eventTypeMeta } from "@/lib/derive/event-type";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Most recent" },
  { value: "confidence", label: "Highest confidence" },
  { value: "name", label: "Name (A–Z)" },
];

const CONFIDENCE_STEPS = [
  { value: null, label: "Any confidence" },
  { value: 0.75, label: "75%+" },
  { value: 0.85, label: "85%+" },
  { value: 0.9, label: "90%+" },
] as const;

const RECENCY_STEPS = [
  { value: null, label: "Any time" },
  { value: 7, label: "Past week" },
  { value: 30, label: "Past month" },
  { value: 90, label: "Past quarter" },
] as const;

export interface CompanyFilterBarProps {
  initial: CompanyFilters;
  categories: string[];
  eventTypes: string[];
  /** "compact" (Radar/home: search + sort + a couple of quick filters) or "full" (Explore: every control). */
  variant?: "compact" | "full";
  searchPlaceholder?: string;
}

export function CompanyFilterBar({ initial, categories, eventTypes, variant = "full", searchPlaceholder = "Search companies…" }: CompanyFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(initial.q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushParams = useCallback(
    (next: Partial<CompanyFilters>) => {
      const merged: CompanyFilters = { ...initial, q, ...next };
      const params = new URLSearchParams();
      if (merged.q) params.set("q", merged.q);
      if (merged.category) params.set("category", merged.category);
      if (merged.eventType) params.set("event", merged.eventType);
      if (merged.minConfidence !== null) params.set("minConfidence", String(merged.minConfidence));
      if (merged.maxAgeDays !== null) params.set("maxAge", String(merged.maxAgeDays));
      if (merged.sort !== "recent") params.set("sort", merged.sort);
      const qs = params.toString();
      startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [initial, q, pathname, router],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q === initial.q) return;
    debounceRef.current = setTimeout(() => pushParams({ q }), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const hasActiveFilters = Boolean(initial.category || initial.eventType || initial.minConfidence || initial.maxAgeDays || initial.q);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[220px] flex-1">
          <svg aria-hidden viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint">
            <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M14 14L17.5 17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search companies"
            className="w-full rounded-md border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/20"
          />
        </div>

        <select
          value={initial.sort}
          onChange={(e) => pushParams({ sort: e.target.value as SortKey })}
          aria-label="Sort"
          className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/20"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              Sort: {s.label}
            </option>
          ))}
        </select>
      </div>

      {variant === "full" && (
        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={initial.category ?? ""}
            onChange={(e) => pushParams({ category: e.target.value || null })}
            aria-label="Category"
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink-muted focus:border-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/20"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            value={initial.eventType ?? ""}
            onChange={(e) => pushParams({ eventType: e.target.value || null })}
            aria-label="Signal type"
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink-muted focus:border-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/20"
          >
            <option value="">All signal types</option>
            {eventTypes.map((e) => (
              <option key={e} value={e}>
                {eventTypeMeta(e).label}
              </option>
            ))}
          </select>

          <select
            value={initial.minConfidence ?? ""}
            onChange={(e) => pushParams({ minConfidence: e.target.value ? Number(e.target.value) : null })}
            aria-label="Minimum confidence"
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink-muted focus:border-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/20"
          >
            {CONFIDENCE_STEPS.map((s) => (
              <option key={s.label} value={s.value ?? ""}>
                {s.label}
              </option>
            ))}
          </select>

          <select
            value={initial.maxAgeDays ?? ""}
            onChange={(e) => pushParams({ maxAgeDays: e.target.value ? Number(e.target.value) : null })}
            aria-label="Discovery window"
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink-muted focus:border-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/20"
          >
            {RECENCY_STEPS.map((s) => (
              <option key={s.label} value={s.value ?? ""}>
                {s.label}
              </option>
            ))}
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                router.push(pathname, { scroll: false });
              }}
              className={clsx("text-sm font-medium text-accent hover:underline")}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
