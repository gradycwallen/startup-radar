const DAY_MS = 86_400_000;

/** "Today" / "3 days ago" / "6 weeks ago", derived from a real timestamp — never invented. */
export function recencyLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const days = Math.max(0, Math.floor((now.getTime() - then) / DAY_MS));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

export function daysSince(iso: string, now: Date = new Date()): number {
  return Math.max(0, (now.getTime() - new Date(iso).getTime()) / DAY_MS);
}

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
