/** Deterministic, muted tint per category string — purely a presentation aid (stable hash → one of
 * a small fixed palette), never stored or treated as meaningful data. */
const PALETTE = [
  "bg-teal-50 text-teal-800 ring-teal-600/15 dark:bg-teal-400/10 dark:text-teal-300 dark:ring-teal-400/20",
  "bg-indigo-50 text-indigo-800 ring-indigo-600/15 dark:bg-indigo-400/10 dark:text-indigo-300 dark:ring-indigo-400/20",
  "bg-amber-50 text-amber-800 ring-amber-600/15 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/20",
  "bg-rose-50 text-rose-800 ring-rose-600/15 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/20",
  "bg-sky-50 text-sky-800 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20",
  "bg-violet-50 text-violet-800 ring-violet-600/15 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/20",
  "bg-emerald-50 text-emerald-800 ring-emerald-600/15 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  "bg-stone-100 text-stone-800 ring-stone-600/15 dark:bg-white/5 dark:text-stone-300 dark:ring-white/10",
] as const;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function categoryClasses(category: string | null): string {
  if (!category) return "bg-zinc-100 text-zinc-600 ring-zinc-600/10 dark:bg-white/5 dark:text-ink-faint dark:ring-white/10";
  return PALETTE[hash(category) % PALETTE.length]!;
}
