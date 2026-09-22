/**
 * Labeled evaluation set: companies the Phase 1 live run discovered (with Claude web search) and verified as real,
 * emerging startups. V2-1 has no LLM, so the question is whether deterministic sources + extraction can recover them.
 *
 * `expectedAsOf` is the daily run that should have caught the company: the day after its event, because that is when a
 * scheduled daily run would first see it. `altDomains` lists other domains that are legitimately the same company.
 */
export interface Label {
  name: string;
  domain: string;
  altDomains?: string[];
  /** Date of the announcement, per the Phase 1 record. */
  eventDate: string | null;
  /** The as-of date of the daily run that should surface it. */
  expectedAsOf: string;
  /** "primary" labels are the ones the acceptance question asks about; "separate" are reported apart. */
  group: "primary" | "separate";
  note?: string;
}

export const LABELS: readonly Label[] = [
  { name: "Project-S", domain: "project-s.space", eventDate: "2026-09-03", expectedAsOf: "2026-09-04", group: "primary" },
  { name: "Fin.com", domain: "fin.com", eventDate: "2026-09-17", expectedAsOf: "2026-09-17", group: "primary", note: "announced Sep 15-17" },
  { name: "Empirik", domain: "empirik.ai", eventDate: "2026-09-01", expectedAsOf: "2026-09-02", group: "primary" },
  { name: "Gaia Dynamics", domain: "gaiadynamics.ai", eventDate: "2026-09-16", expectedAsOf: "2026-09-17", group: "primary" },
  { name: "ScrollEd", domain: "scrolled.org", eventDate: "2026-09-20", expectedAsOf: "2026-09-21", group: "primary" },
  { name: "TypeSafe AI", domain: "typesafe.ai", eventDate: "2026-09-16", expectedAsOf: "2026-09-17", group: "primary" },
  { name: "Aiir", domain: "useaiir.com", eventDate: "2026-09-18", expectedAsOf: "2026-09-19", group: "primary" },
  { name: "Sunzu", domain: "sunzu.com", altDomains: ["sunzu.ai"], eventDate: "2026-09-18", expectedAsOf: "2026-09-19", group: "primary", note: "Techstars' own page lists sunzu.ai; Phase 1 recorded sunzu.com" },
  { name: "heylogin", domain: "heylogin.com", eventDate: null, expectedAsOf: "2026-09-21", group: "separate", note: "Phase 1 discovery event was a 'Startup of the Month' directory listing; questionable" },
];
