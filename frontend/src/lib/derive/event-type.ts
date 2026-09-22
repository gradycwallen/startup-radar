import type { EventType } from "../data/types";

export interface EventTypeMeta {
  label: string;
  short: string;
}

const META: Record<EventType, EventTypeMeta> = {
  funding: { label: "Funding round", short: "Funding" },
  stealth: { label: "Emerged from stealth", short: "Stealth" },
  product_launch: { label: "Product launch", short: "Launch" },
  accelerator: { label: "Accelerator / cohort", short: "Accelerator" },
  open_source: { label: "Open-source release", short: "Open source" },
  news: { label: "News mention", short: "News" },
};

const FALLBACK: EventTypeMeta = { label: "Signal detected", short: "Signal" };

export function eventTypeMeta(eventType: string): EventTypeMeta {
  return META[eventType as EventType] ?? FALLBACK;
}
