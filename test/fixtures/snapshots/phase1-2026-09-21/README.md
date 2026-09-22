# Phase 1 replay fixture (2026-09-21)

Static snapshot for offline regression tests. Derived from the real Phase 1 live run `20260921T224712Z-so64`
and the database seed rows at that time. **No secrets; only public company/source information.**

- `discovery.json`: the 14 leads that reached verification, with the lane reports. The 22 leads that were not
  selected were never logged by Phase 1 and cannot be reconstructed.
- `verifications.json`: verification results for 9 accepted candidates and the 1 stale-event rejection (Ollama).
  These are **reconstructed from the run summary**: the verbatim model evidence quotes were not preserved in Phase 1.
- The 4 candidates that failed on insufficient credit (Langfuse, Ferry Health, PrismML, TigerByte Cyber) have **no**
  recorded verification, on purpose: replaying them proves a missing recording fails loudly instead of going live.
- `homepages.json`: synthetic "reachable, mentions the name" results for the recorded domains.
- `db.json`: the 10 seed companies and 10 events.
- `manifest.now` fixes the clock to 2026-09-21T23:00:00Z so date rules (event freshness) behave as they did.
