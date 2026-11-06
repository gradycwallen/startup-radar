# Reviewer-facing data spot check — November 6, 2026

A read-only spot check of the first 11 default-sorted directory entries and selected profiles. This is not a full database audit. The ordering and records can change; verified source content does not prove every observation or signal in a profile. No database records were changed.

## Findings requiring follow-up

- **Charter Space (additional sample): incorrect domain.** The database lists `space.com`; the company's own [funding announcement](https://www.charter.space/news/seed-round-2026) is on `charter.space`, and the [TechCrunch report](https://techcrunch.com/2026/09/30/charter-space-raises-5m-to-bring-insurance-to-the-stars/) describes the same insurance company. This is a concrete identity mismatch. The source article should not be interpreted as proof that space.com is its domain. Review dependent source resolutions and observations before any correction; no database update was made.
- **XDOF: funding event label may overstate the source.** The [linked TechCrunch article](https://techcrunch.com/2026/09/04/xdof-just-three-months-out-of-stealth-is-in-talks-for-a-series-b-at-a-1-2b-valuation/) reports Series B talks, not a completed Series B. It also reports a prior completed Series A. The stored discovery reason preserves that distinction, but the generic Funding event label and synthetic headline merit review.
- **Source link verification limits.** The stored ArcticStartup GitHits link timed out in the audit tool, while its [indexed article](https://arcticstartup.com/githits-raises-e1-5m-pre-seed/?amp=1) corroborates the account. The exact stored Chamelio PR Newswire URL could not be fetched by the audit tool, while the [indexed release](https://www.prnewswire.com/il/news-releases/chamelio-raises-26m-series-a-to-replace-legacy-clm-with-ai-native-in-house-legal-operations-302886011.html) corroborates the headline. These failures do not prove the stored links are broken in a normal browser.

## First 11 entries examined

- **GitHits:** `githits.com` and its product are consistent with the [company website](https://githits.com/) and [funding article](https://arcticstartup.com/githits-raises-e1-5m-pre-seed/?amp=1). The profile has GitHub and website signal sources; individual signal accuracy was not exhaustively audited.
- **Restate:** `restate.dev` and its $20M Series A are corroborated by the [company's announcement](https://restate.dev/blog/announcing-series-a) and [TechCrunch](https://techcrunch.com/2026/09/30/restate-lands-20m-as-the-need-for-durable-infrastructure-increases-with-ai-agents/). Its profile has GitHub, hiring and website sources.
- **Chamelio:** `chamelio.ai` matches the [company site](https://www.chamelio.ai/) and the $26M Series A matches the [company's press release](https://www.prnewswire.com/il/news-releases/chamelio-raises-26m-series-a-to-replace-legacy-clm-with-ai-native-in-house-legal-operations-302886011.html). Its profile has hiring and website sources.
- **XDOF:** `xdof.ai` presents the XDOF name and the [TechCrunch article](https://techcrunch.com/2026/09/04/xdof-just-three-months-out-of-stealth-is-in-talks-for-a-series-b-at-a-1-2b-valuation/) supports the product description and prior Series A. See the event-label caveat above.
- **machine0:** its [YC page](https://www.ycombinator.com/companies/machine0) links `machine0.io` and confirms the Summer 2026 cohort.
- **Definite:** its [YC page](https://www.ycombinator.com/companies/definite) references `usedefinite.com` and confirms Fall 2026, though its founder biography also refers to S26.
- **Axonnic:** the [YC page](https://www.ycombinator.com/companies/axonnic) and [company site](https://www.axonnic.com/) support the name, domain and Fall 2026 cohort.
- **Adalat AI:** its [YC page](https://www.ycombinator.com/companies/adalat-ai) lists `adalat.ai` and Fall 2026.
- **Plover Labs:** its [YC page](https://www.ycombinator.com/companies/plover-labs) lists `ploverlabs.ai` and Fall 2026.
- **Applied Electrodynamics:** its [YC page](https://www.ycombinator.com/companies/applied-electrodynamics-inc) lists `ae-dyn.com` and Summer 2026.
- **Bloomy:** listed as `bloomylearning.com` and YC Summer 2026, but the exact source and identity were not independently verified in this pass. Treat as unresolved, not confirmed.

The homepage examples were selected manually from GitHits, Restate and Chamelio for corroborated identities and discovery reports plus existing signal history. Those examples are not a claim that every linked signal or future change has been independently verified.
