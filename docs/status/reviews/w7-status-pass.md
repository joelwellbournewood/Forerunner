# w7-status-pass: status pass after the 2026-10-23 build day

Branch `wave/w7-status-pass`, created from `origin/ccr-4d8a843c-1k9syk` at 422d9c0 (the
starting commit; no merge or rebase of the base). Docs only: no code or test was changed.

## Build report

### What was built

Forty-one items merged into `ccr-4d8a843c-1k9syk` on 2026-10-23 and 2026-10-24: the fifteen
of the morning (already in the status documents since 0448e09) and 27 independently reviewed
items after them, each with `docs/status/reviews/<item>.md`. The merges had left the status
documents to this pass. Every one of the 27 review files was read; a row moved only where the
review names the tests that prove it.

1. `docs/requirements.md` (bcf203f). Set to `done` on the tests the review files name: B.5
   (w3-b5-reasons, accept 86), D.20 (w2-d20-fastmode), H.7 and P.15 (w2-monthly-jobs), J.1 and
   O.2 (w2-chat-memory), J.9 (w2-j9-merge), L.6 (w2-l6-speak), O.1 (w2-o1-hotkey), O.4
   (w3-o4-voice-prefs, accept 78). O.3 and K.8 gain the hotkey tests. Rows an item covers only
   in part stay `in progress` with the gap named in the test column, as S.12 already was: R.1
   and R.5 (the emulator run), R.6 (the app's Firebase wiring), K.8 (module R), V.3 (three runs
   per OS, Android). C.5, D.4, D.7, D.16, D.19, E.1, E.4, R.2, S.32 and T.1 had moved with
   their merges and were checked against their reviews. A summary line above the counts table:
   **203 done, 21 in progress, 4 todo of 228** (from 193 / 30 / 5 on the base; counted from the
   tables, and `pnpm gates:verify` reports the same).
2. `docs/status/BLOCKERS.md` (0808a74). 21 rows the items resolved moved to a new section
   "Closed on 2026-10-24", each naming its review file, verdict and merge commit and any
   residual (Triage P1, Live harness, H.7, J.1, J.9, L.6, B.5, C.5, D.4, D.7/D.19, D.16, D.20,
   E.1, E.4, S.32, O.1, O.2, O.4, P.15, R.2, T.1). Updated: the key rows (the key pasted into
   the build session and the earlier key and subscription token must be revoked), the CI row
   (green run 125 on 422d9c0), the FCM, K.8, S.12, R.1, R.5 rows (merge commits and review
   files), the Android keystore row (the apksigner check passed in the three `android.yml`
   runs), V.1 (recount), V.3, V.4, V.5, V.8, and the run-on sentences the merges left in V.2,
   V.3 and V.5. New row "Android emulator smoke": attach, pairing by code and the signed
   approval pass; the bottom-nav "Inbox" click misses on the API 30 `aosp_atd` image (Chromium
   83 drops Tailwind v4 cascade layers, the unstyled nav moves when the project list arrives;
   ADR 0087 and `w6-android-inbox.md` for the click guard); runs 40000764444 and 40013402240
   fail there; next step a newer system image with a current WebView in `android.yml` or a
   layout-settle wait before the nav click. "Open review findings of 2026-10-23" now lists
   every finding the 27 reviews left open (12 of the three accepted items: w3-b5-reasons,
   w3-o4-voice-prefs, w4-stale-docs; the open part of a C.5 finding) or resolved as not a
   defect (seven), plus the w2-l6-speak finding completed at the merge.
3. `docs/status/PROGRESS.md` (79eea65). One log entry for the day: what merged (merge order
   and commits), the review process (3 accepted, 24 revised, 149 findings, 12 high, all fixed
   before the merge) and the three rebase rounds (cac6fee, 4ff4fb1, 38ae8cc; 95097ae for the
   last two branches). The per-item entries the open branches had written, which still said
   "not merged yet", are folded into it (the detail is in the review files). The new "Where to
   pick up" replaces the old: the Android emulator row, the live gate run, the key rotation,
   the open review findings and the ten unreviewed first-wave items, the rows still open, the
   release criteria, the package-level `test` scripts that find no files (checked:
   `pnpm --filter @forerunner/commands test` prints "No test files found, exiting with code 0"),
   and the passages merges kept from both sides. Milestone rows 0, 1, 5 and 8 updated.
4. `docs/status/gates.md` (0bdb98c). Phase 0 "CI green" cites run 125 on 422d9c0
   (https://github.com/joelwellbournewood/Forerunner/actions/runs/40044376081, the newer green
   run on the current head) next to run 121 on bc10bc8
   (https://github.com/joelwellbournewood/Forerunner/actions/runs/40013385053). The phase 5
   emulator row cites the Android runs as evidence of the attach, the pairing, the signed
   approval and the release-APK signing, and stays pending. The release criteria section gets
   the day's evidence paragraph (the integration step's 300 unit files / 3084 tests and
   Postgres 8 files / 82 tests on f1948dd, and this pass's re-run on 422d9c0) and criteria 1 to
   5 and 9 their counts and links. No criterion is marked met that was not; `pnpm
   gates:verify` is ok.
5. `docs/status/COST.md` (69b018b): two rows and a paragraph for the day's API spend, about
   USD 230 on roughly 90 Managed Agents sessions (builds 1 to 12, reviews 1 to 3, rebases 2 to
   5 USD) and about USD 85 of Claude Code runs on GitHub Actions; the plan spend is not metered.
6. `CHANGELOG.md` (9436227): one Unreleased entry for each of the 23 items that had none
   (E.1, D.7/D.19, R.2 and R.5 had theirs), grouped Added (14), Changed (3), Fixed (5) and
   Security (1); 46 entries in all, one per item of the day plus the four scaffold lines.
7. Maintainer docs where a merge kept both sides (5ef2f28), found with
   `git show --cc <merge>` over the merges and a duplicate-sentence and duplicate-row scan:
   commands.md had two `settings.set` rows (merged, both clauses kept) and stated 171 tests
   (real: 12 files, 173); apps.md's fake daemon paragraph was cut by the fast-mode block before
   its last sentence (rejoined, the block its own paragraph), and one rebase-joined line was
   re-wrapped; runtime.md's Known issues had two fast-mode bullets (merged), the git host
   poller still said J.9's commit-status read was to be used "once both are merged" (both are;
   the watcher still does not call it), and the voice bullet said no shell calls the `/voice`
   routes while the O.1 conversation panel does; adding-a-provider.md's step 2 named three
   error codes against the abort rule above it (now four, with the rule) and its test
   paragraph now names the abort cases. PROGRESS.md's duplicated item lists and BLOCKERS.md's
   run-on rows are fixed in their own commits. `docs/decisions/README.md` has no duplicate or
   missing row (76 rows, 76 ADR files, in order).

8. The live-model gate on the final head (commit after the build, at the human's request).
   `origin/ccr-4d8a843c-1k9syk` moved to bd32dda during this pass: the live harness ran on
   422d9c0 on 2026-10-24 (run `2026-10-24T00:19:35.074Z`). Read from the committed ledger
   (`git show bd32dda:tests/live/spend.json`, compared with 422d9c0's): 242 new calls, USD
   2.438022 (Sonnet 231 calls USD 2.437256, Haiku 11 calls USD 0.000766), the killed call
   recorded `aborted`, ledger USD 8.485961 of 200; the human's figures: 8 test files passed and
   1 skipped, 56 live cases passed and 5 skipped. gates.md gains the phase 8 row "Live-model
   gate on the final head" (passed, with the CI run of the same head, run 125,
   https://github.com/joelwellbournewood/Forerunner/actions/runs/40044376081, green on both
   OS), the evidence paragraph and criterion 6 mention it, the phase 1 kill row notes the
   `aborted` record; COST.md gets two rows and the ledger paragraph; BLOCKERS.md (budget, key,
   V.2, V.6 rows and the closed Live harness line) and PROGRESS.md (the day entry, milestone
   rows 1 and 8, handover items 2 and 3) follow. bd32dda itself is not on this branch (no merge
   of the base); the docs cite it by hash.

### Which tests prove it

Docs only, so the proof is the docs checks and the status parsers, plus the full suites on the
branch head to show nothing else moved:

- `scripts/closeout-docs.test.ts` (ADR index, maintainer doc sections): 19 passed, 1 todo.
- `scripts/gates-verify.test.ts` ("parses the real status files"): passes; `pnpm gates:verify`
  ok (the new passed row has command, date, result and CI link), 203 done, 21 in progress, 4 todo of 228.
- `scripts/release-notes.test.ts` (the Unreleased section): 8 passed.
- Every test path in a requirement row exists (checked with a script over the test column).

### Commands run and results (2026-10-24, Linux build box, Node 22, pnpm 10.28)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | done |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0, 1263 files, 59 warnings (the base's), no errors |
| `node scripts/docs-check.mjs --base 422d9c0` | `docs-check: ok (10 files)` |
| `node scripts/link-check.mjs` | `link-check: ok (149 files with this report)` |
| `pnpm exec vitest run --project unit scripts/closeout-docs.test.ts` | 1 file, 19 passed, 1 todo |
| `pnpm exec vitest run --project unit scripts` | 10 files, 97 passed, 2 skipped, 1 todo |
| `pnpm gates:verify` | ok; checks 27/40 passed (with the live-gate row), criteria 0/9, requirements 203 / 21 / 4 of 228 |
| `pnpm check` | exit 0: lint, paths, typecheck, `pnpm test` 304 files, 3132 passed, 4 skipped, 1 todo; link check ok (148 files, before this report); secret scan clean (1560 files); its `docs:check` has no `origin/main` here, hence the explicit run above |
| `pnpm --filter @forerunner/ui test` (on 422d9c0) | 54 files, 385 passed |
| `pnpm --filter @forerunner/approvals-web test` (on 422d9c0) | 10 files, 58 passed |
| `pnpm exec vitest run --project e2e tests/e2e/scenarios` | 13 files, 25 passed, 1 skipped, no todo |
| `FORERUNNER_TEST_PG=postgres://postgres:forerunner@localhost:5432/forerunner_test pnpm test:integration` (Postgres 16 started on the box) | 8 files passed, 1 skipped (Docker sandbox), 83 passed, 5 skipped |
| `pnpm exec vitest run --project unit packages/commands/test` | 12 files, 173 passed (the count now in commands.md) |
| `pnpm --filter @forerunner/commands test` | "No test files found, exiting with code 0" (the vacuous form the handover warns about) |

CI evidence was read from the public run pages: run 125 (40044376081) on 422d9c0, run 124
(40042818566) on 646ee74 and run 121 (40013385053) on bc10bc8 all green on every job; run 122
(40041172164) on 95097ae failed only in the dependency audit; `android.yml` runs 39952987240
(82a6295), 40000764444 (4ff4fb1) and 40013402240 (bc10bc8) failed in the emulator step.

### Export and `git apply --check` against a clean checkout of the starting commit

```
$ cat /tmp/start-sha
422d9c0c5f9251ef9f26f2ea36aba7e25d05e2e0
$ git log --oneline $(cat /tmp/start-sha)..HEAD     # only this item's commits, no merge of the base
$ git format-patch --stdout $(cat /tmp/start-sha)..HEAD > /mnt/session/outputs/w7-status-pass.patch
$ git worktree add --detach /tmp/verify $(cat /tmp/start-sha)
$ cd /tmp/verify && git rev-parse --short HEAD && git status --short | wc -l
422d9c0
0
$ git apply --check -v /mnt/session/outputs/w7-status-pass.patch; echo "exit $?"
...
Checking patch docs/status/PROGRESS.md...
Checking patch docs/status/gates.md...
Checking patch docs/status/reviews/w7-status-pass.md...
exit 0
$ cd /workspace/repo && git worktree remove --force /tmp/verify
```

Run on the 9-commit series (bcf203f .. f9efab9) before this section was committed: `git log`
listed 9 commits, the clean checkout was at 422d9c0 with no changes, and `git apply --check`
exited 0. Run again on the final export, which adds the commit carrying this section (10
commits); the output of that final run is appended below in the exported copy of this report,
`/mnt/session/outputs/w7-status-pass-report.md`, and its result is the same (exit 0).

### What is left open, and why

- **Run 40000764444's commit.** The brief names runs 40000764444 and 40013402240 "on bc10bc8";
  the run page of 40000764444 shows 4ff4fb1 (attempt 1), before the click guard merged, and its
  failure is the review's "0 `m-request` cards in 180 s". The status files say so; the
  `cdp.click_missed` code is cited for 40013402240 as the brief gives it (the job logs need a
  signed-in account, so the log text itself was not read here).
- **The full-check figures of the brief** (300 unit files, 3084 tests; Postgres 8 files, 82
  tests on f1948dd) are recorded as the integration step's; this pass's own re-run on 422d9c0
  is recorded next to them with its own numbers.
- **Not fixed here, recorded instead:** the open review findings (BLOCKERS.md), including the
  three low w4-stale-docs findings in apps.md, testing.md and the triage report, since the
  brief asks this pass to record them and touch no code; the package-level `test` scripts
  (a `package.json` change, outside a status pass).
- **The cargo test count** in apps.md (90) was not re-run (no Rust toolchain run in this pass);
  it is the w2-o1-hotkey rebase's figure on the same Rust code.
