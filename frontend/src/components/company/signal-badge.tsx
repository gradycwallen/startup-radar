import { Badge } from "@/components/ui/badge";
import { eventTypeMeta } from "@/lib/derive/event-type";

export function SignalBadge({ eventType, short = false }: { eventType: string; short?: boolean }) {
  const meta = eventTypeMeta(eventType);
  return <Badge className="bg-ink text-canvas ring-ink/10">{short ? meta.short : meta.label}</Badge>;
}
