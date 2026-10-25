# w8-android-nav-settle: the bottom-nav click on the hosted API 30 emulator (android.yml run 40013402240)

Branch `worktree-agent-a075ff8dd009e2844`, from `ccr-af5a431d-jc9xqj` at 7ad6011. ADR 0087 amendment (2026-10-25).

## Build report

- Run 40013402240 (bc10bc8) failed the "Inbox" click as `cdp.click_missed` for 30 s: every retry measured the same stable box, the in-page hit test found the nav item at (67, 453), and every dispatched event landed on bare `#root`. `#root { height: 100% }` (`apps/ui/src/styles.css`) is a plain rule outside Tailwind's layers, so on Chromium 83 `#root` is viewport-tall while the unstyled content is shorter: the WebView's input path put the point below the content. A coordinate disagreement between `Input.dispatchMouseEvent` and the page, not the layout race ADR 0087 closed; the exact cause (offset or scale) needs a device and is not known here.
- `apps/mobile/e2e/cdp.mjs`: `click` runs one in-page call that waits for the layout to settle (box, scroll height and position unchanged over 5 frames and 300 ms; no DOM mutation for 300 ms, capped at 1.5 s of stable geometry), scrolls into view with `behavior: "instant"`, waits again when that moved the box, then measures, hit-tests and arms the guard right before the mouse events (`settled: false` at the budget's end sends nothing). The guard also covers `touchstart`/`touchend` (`passive: false`) and records `clientX`/`clientY` of a misplaced event. After three guarded misses at one unchanged box the ladder runs, each step a `click fallback: <locator> (cdp.click_missed: <why>)` line on `page.log` (default `console.log`): a mouse click shifted by the reported offset, an `Input.dispatchTouchEvent` tap (a refusal moves on), then `element.click()` in the page under its own guard. `cdp.click_missed` stays the error when that raises no click; `cdp.click_intercepted` keeps no fallback (the page says the element is covered); new `cdp.click_unsettled`. Nothing is printed when the first path lands. `run.mjs` is unchanged (PASS lines, steps, `webview engine:`).
- `apps/mobile/e2e/cdp.test.ts`: 36 tests, 4 new, committed first and failing on the old driver with the run's own line (`Tests 4 failed | 1 passed | 31 skipped (36)`): the growing page gets one press after its last box change and DOM mutation; events delivered 30 px lower get three misses then the shifted click; no offset to learn, the tap; a tap that misses too, `element.click()`; all three failing, `cdp.click_missed` naming everything tried. The fake grew an input path (`fakeInputPath`: target, seen-at point, touch target). `cdp.d.mts` types `log`, `touchTap`, the evaluate timeout.
- Docs: `apps.md` (cdp.mjs entry, test coverage, Known issues: the run, the withdrawn coordinate assumption, what the next run's lines tell), `apps/mobile/e2e/README.md`, ADR 0087 amendment. Not edited: requirements, PROGRESS, BLOCKERS, gates, COST, CHANGELOG, `docs/decisions/README.md` (the row texts are in the hand-back).

| Command | Result |
| --- | --- |
| `pnpm exec vitest run --project unit apps/mobile/e2e` (new tests, old driver) | 4 failed, 1 passed, 31 skipped (36) |
| `pnpm exec biome check --write` then `biome check` on cdp.mjs, cdp.test.ts, cdp.d.mts | Checked 3 files. No fixes applied; no warnings |
| `node --check apps/mobile/e2e/cdp.mjs && node --check apps/mobile/e2e/run.mjs` | ok |
| `pnpm exec vitest run --project unit apps/mobile/e2e` (final) | 1 file, 36 passed |
| `pnpm typecheck` | no error in this item's files; 3 errors in `scripts/package-test-scripts.test.ts`, unchanged from the fork point 7ad6011 and already fixed on `ccr-af5a431d-jc9xqj` (b359a3c) |
| `node scripts/check-paths.mjs` | exit 1 with one finding, that same base file (`node:path` import, fixed in b359a3c); none under apps/mobile |
| `node scripts/docs-check.mjs --base ccr-af5a431d-jc9xqj` | docs-check: ok (6 files) |

Left open: no emulator here, so the dispatch decides; the `click fallback:` lines of the next run say which path landed ("shifted by" = a constant offset in the WebView's input path, "element.click()" = neither input path reaches below the first screen on this image). The old WebView's layout (newer image or flattened layers) stays a separate item.
