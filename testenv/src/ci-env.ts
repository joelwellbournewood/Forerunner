import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Only the paths module: a setup file runs in the test's own module graph before the test, so
// anything it loads is loaded before the test's `vi.mock`s. `@forerunner/platform` as a whole
// would load the shell runner with the real `node:child_process`, and the spawn recorder of
// scripts/handover-live.test.ts would see nothing.
import { join } from "@forerunner/platform/paths";

/**
 * Every test runs in the environment CI gives it, on any machine (docs/maintainers/testing.md,
 * "Tests run as CI runs them"). On 2026-11-02 (c8c16fb) three tests passed on the machine that
 * validated them and failed on CI, because that machine differed from CI in two ways:
 *
 * - **No git identity.** CI's runners have no `user.name` or `user.email` (Linux: "empty ident
 *   name not allowed"; Windows: "unable to auto-detect email address"). A test that ran a plain
 *   `git merge` passed wherever the person had set up git. Git's global config is an empty file
 *   here, so no test can lean on the machine's identity (or its commit signing): a commit needs
 *   an identity the test or the product gives it, as on a person's PC that never set up git.
 * - **FORCE_COLOR=1.** `ci.yml` sets it for every step, so every program a test starts prints
 *   colour even into a pipe: `console.log(9)` printed `\x1b[33m9\x1b[39m` into a tried command's
 *   evidence. It is set here too, so a test sees the output CI sees; `NO_COLOR`, which a person
 *   may have set, would hide it and is removed.
 *
 * A setup file (`setupFiles` in the root `vitest.config.ts` and in `apps/ui`), so it runs in each
 * test worker before its test files; the processes a test starts inherit it. A test that needs
 * another git config or colour setting passes its own environment to the process it starts.
 */
const MARK = "FORERUNNER_TEST_CI_ENV";

if (!process.env[MARK]) {
  // One empty file per worker process: a test that writes to "the global config" (none should)
  // cannot change what another worker's tests read. It is in the run's own temp folder
  // (test-tmp.ts), which the run removes: most workers end without running their exit handler
  // (a unit run left 430 of these files in the system temp folder before 2026-11-03).
  const empty = join(tmpdir(), `forerunner-test-gitconfig-${process.pid}`);
  writeFileSync(empty, "");
  process.on("exit", () => rmSync(empty, { force: true }));
  process.env.GIT_CONFIG_GLOBAL = empty;
  // Identity from the environment is the machine's too; CI sets none of these.
  for (const k of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "EMAIL",
  ])
    delete process.env[k];
  process.env.FORCE_COLOR = "1";
  delete process.env.NO_COLOR;
  process.env[MARK] = "1";
}
