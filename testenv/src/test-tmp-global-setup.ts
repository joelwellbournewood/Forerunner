import { ENV_OWNER, startTestTmp, type TestTmpRun } from "./test-tmp.ts";

/**
 * vitest `globalSetup` of every vitest config in the repository (the root one, whose projects
 * are unit, integration and e2e; `tests/live`; `apps/ui`; `apps/approvals-web`): one temp folder
 * per run, removed at its end (`test-tmp.ts`; testing.md, "Where test temp files go").
 *
 * A global setup runs in vitest's main process before any worker starts, and vitest builds each
 * worker's environment from `process.env` when it starts the worker, so TMPDIR, TMP and TEMP set
 * here reach every worker and every process a test starts. The teardown runs after the last
 * test file.
 *
 * Two configs in one process (a global setup named at the root and again in a project) share
 * one folder: the last teardown removes it. A vitest run started by a test (its environment
 * names another process as the owner) makes its own folder inside its parent's.
 */
interface Shared {
  run: TestTmpRun;
  users: number;
}
const KEY = Symbol.for("forerunner.test-tmp");
type WithShared = typeof globalThis & { [KEY]?: Shared };

export default function setup(): () => void {
  const g = globalThis as WithShared;
  let shared = g[KEY];
  if (shared && process.env[ENV_OWNER] === String(process.pid)) shared.users += 1;
  else {
    shared = { run: startTestTmp(), users: 1 };
    g[KEY] = shared;
  }
  const mine = shared;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mine.users -= 1;
    if (mine.users > 0) return;
    if (g[KEY] === mine) delete g[KEY];
    mine.run.stop();
  };
}
