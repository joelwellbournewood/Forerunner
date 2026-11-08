- 2026-11-08 18:13 UTC: Desktop app run 42503802703 on ca2c58d (wave 12): Windows Playwright failed once on
  e2e/extensions.spec.ts:67 "the daemon's extension.changed frame reloads the panel" (page.goto net::ERR_ABORTED,
  30 s timeout at its first line); the re-run of the failed job passed all 34. Flaky test (Windows runner); wave 12
  did not touch that path. CI on d189ffd (same code) green.
- 2026-11-08 18:35 UTC: wave 12's merge fully green: CI on d189ffd (same code as ca2c58d) and the Desktop app run 42503802703 attempt 2 on ca2c58d (Windows and Linux builds, installed-app check, real-window check).
