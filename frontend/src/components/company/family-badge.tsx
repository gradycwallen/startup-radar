import { Badge } from "@/components/ui/badge";

/** A quiet, text-first family label ("Hiring"/"GitHub"/"Website") — deliberately NOT the loud
 * solid-black pill `SignalBadge` uses for discovery events (root CLAUDE.md's V2-3A design report
 * §8/§16: family is secondary metadata on a signal card, not the primary marker, and this app
 * reserves strong color/weight for the things that actually matter most on a row). No per-family
 * color — see the design report for why a 4th color axis was deliberately avoided. */
export function FamilyBadge({ label }: { label: string }) {
  return <Badge className="bg-transparent text-ink-faint ring-line">{label}</Badge>;
}
