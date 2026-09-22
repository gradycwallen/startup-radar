/** One line of plain text — never a percentage, a bar, or a count badge. See
 * src/lib/derive/signal-view-model.ts: buildCoverageLine for exactly what this can and can't say
 * (source availability must never visually resemble company quality). Renders nothing when there's
 * nothing honest to say yet (no sources at all — that case has its own empty-state message
 * instead, see SignalIntelligenceSection). */
export function CoverageLine({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="mt-1.5 text-sm text-ink-muted">{text}</p>;
}
