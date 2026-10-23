## title

Known issues entries already fixed are closed in the maintainer docs with their evidence

## requirements

P.3 to P.12 (maintainer docs true to the code), V.4

## adr

none

## brief

The triage of 2026-10-23 (docs/status/reports/triage-2026-10-23.md, section 'Already fixed') found 20 Known issues entries that the code has already closed; each names the evidence (file and line). Update every one of those entries in docs/maintainers/*.md: remove the entry, or where the doc keeps closed items as records (testing.md's phase 5 list does), mark it closed with the date and the evidence. Verify each piece of evidence yourself against the source before editing (the triage was read-only and may have misread one). Also fix the two docs-only P2 rows the triage marked trivial: desktop-control.md (8) the ADR index row 0021 title, and the `notifications.md` (8) link only if it is a one-line doc fix (otherwise leave it). Do not touch entries listed as 'being built' or P2. Docs-only item (no code), but keep `pnpm docs:links` and `scripts/closeout-docs.test.ts` green and run `pnpm exec vitest run --project unit scripts`. Note: the machine is shared with other builders.

## hints

Read docs/status/reports/triage-2026-10-23.md 'Already fixed' table first; then each named doc section. The docs README index (docs/decisions/README.md) you may edit ONLY for the 0021 title fix.

## paths

docs/maintainers/*.md
