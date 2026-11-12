import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center  border border-dashed border-line-strong bg-surface/60 px-6 py-16 text-center">
      <p className="font-serif text-lg text-ink">{title}</p>
      {description ? <p className="mt-2 max-w-sm text-sm text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
