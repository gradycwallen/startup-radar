"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import type { CompanyFilters, SortKey } from "@/lib/filters";
import { eventTypeMeta } from "@/lib/derive/event-type";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "momentum", label: "Momentum" },
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

/** A native `<select>` styled as plain text with its own chevron — no box, no bg, no OS-default
 * arrow glyph breaking the otherwise bespoke type-driven UI (see the design audit this replaced).
 * Still a real `<select>` throughout: full keyboard/native-picker accessibility for free. */
function SelectField({
  value,
  onChange,
  ariaLabel,
  emphasized = false,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  emphasized?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={clsx(
          "cursor-pointer appearance-none border-b border-transparent bg-transparent py-1 pr-5 text-left transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
          emphasized ? "font-medium text-ink" : "text-ink-muted hover:text-ink",
        )}
      >
        {children}
      </select>
      <svg aria-hidden viewBox="0 0 10 6" className="pointer-events-none absolute right-0 h-1.5 w-2.5 text-ink-faint">
        <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </span>
  );
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
      if (merged.sort !== "momentum") params.set("sort", merged.sort);
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
    <div className="flex flex-col gap-4">
      {/* The search input already carries its own underline — a row-level border directly under
          it as well read as two redundant hairlines stacked a few pixels apart (found in review).
          Only add the row rule when there's a second row (full variant) it actually needs to
          separate from; the compact variant relies on margin alone. */}
      <div className={clsx("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6", variant === "full" && "border-b border-line pb-4")}>
        <div className="relative w-full sm:max-w-md">
          <svg aria-hidden viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint">
            <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M14 14L17.5 17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search companies"
            className="w-full border-b border-line bg-transparent py-2 pl-6 text-[15px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          />
        </div>

        <SelectField value={initial.sort} onChange={(v) => pushParams({ sort: v as SortKey })} ariaLabel="Sort" emphasized>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              Sort: {s.label}
            </option>
          ))}
        </SelectField>
      </div>

      {variant === "full" && (
        <div className="flex flex-wrap items-center gap-x-7 gap-y-3 text-sm">
          <SelectField value={initial.category ?? ""} onChange={(v) => pushParams({ category: v || null })} ariaLabel="Category">
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>

          <SelectField value={initial.eventType ?? ""} onChange={(v) => pushParams({ eventType: v || null })} ariaLabel="Signal type">
            <option value="">All signal types</option>
            {eventTypes.map((e) => (
              <option key={e} value={e}>
                {eventTypeMeta(e).label}
              </option>
            ))}
          </SelectField>

          <SelectField
            value={initial.minConfidence !== null ? String(initial.minConfidence) : ""}
            onChange={(v) => pushParams({ minConfidence: v ? Number(v) : null })}
            ariaLabel="Minimum confidence"
          >
            {CONFIDENCE_STEPS.map((s) => (
              <option key={s.label} value={s.value ?? ""}>
                {s.label}
              </option>
            ))}
          </SelectField>

          <SelectField
            value={initial.maxAgeDays !== null ? String(initial.maxAgeDays) : ""}
            onChange={(v) => pushParams({ maxAgeDays: v ? Number(v) : null })}
            ariaLabel="Discovery window"
          >
            {RECENCY_STEPS.map((s) => (
              <option key={s.label} value={s.value ?? ""}>
                {s.label}
              </option>
            ))}
          </SelectField>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                router.push(pathname, { scroll: false });
              }}
              className="text-sm font-medium text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
