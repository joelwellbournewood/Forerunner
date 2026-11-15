import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { firstSnapshotRef, LOCAL_ONLY_DIR } from "@forerunner/capabilities";
import type { CheckCommand } from "@forerunner/critic";
import { join, type RunOptions, type RunResult } from "@forerunner/platform";
import { TRY_FOLDER } from "./try-plan.ts";

/**
 * The project's own build, lint and tests (ADR 0104, the owner's decision of 2026-11-01): for
 * a code task they always run before the critic reads, at every review level, and they are
 * never shown to the person as a level. They come from the project itself, never from a prompt:
 * the `scripts` of the `package.json` at the root of the task's folder, in the order a person
 * runs them. A project's `settings.checks` (the commands a person set) run as well.
 *
 * What is not a check: npm's placeholder test script ("no test specified"), and anything when
 * the dependencies the scripts need are not installed in the folder (they could only fail for
 * that reason, and the review says so instead).
 */
export const PROJECT_SCRIPTS = ["build", "lint", "typecheck", "test"] as const;

/** Each project check gets this long (a slow test suite is still a suite). */
export const PROJECT_CHECK_TIMEOUT_MS = 5 * 60 * 1000;

/** npm's placeholder when `npm init` wrote no real test script. */
const NO_TEST = /no test specified/i;

/** File types that are documentation or notes, not code: a change of only these is not a code task. */
const DOC_FILE = /\.(md|markdown|mdx|txt|rst|adoc)$/i;
const DOC_DIR = /^(docs|notes|checks)\//i;

/**
 * Whether a change is code (ADR 0104: the project's build, lint and tests run for a code task):
 * any changed file that is not documentation or notes. A page (`.html`, `.css`, `.js`) is code.
 */
export function isCodeChange(changedFiles: readonly string[]): boolean {
  return changedFiles.some((f) => {
    const p = f.replace(/\\/g, "/");
    return !DOC_FILE.test(p) && !DOC_DIR.test(p) && !/^(LICENSE|NOTICE)(\.|$)/i.test(p);
  });
}

export interface ProjectChecks {
  checks: CheckCommand[];
  /** Why the project's scripts were not run, in words; null when they were or there are none. */
  skipped: string | null;
  /**
   * What the critic is told about the scripts themselves (L-5): a script the task changed,
   * added or removed, and which version each check ran.
   */
  notes: string[];
}

/** The package.json scripts of the task's folder as they were before the task (L-5). */
export interface ScriptsBefore {
  scripts: Record<string, string>;
}

/**
 * The project's build, lint and tests from its `package.json` (`npm run <script>`), in the
 * order of `PROJECT_SCRIPTS`; none when the folder has no `package.json` or it cannot be read.
 *
 * L-5 (live, 2026-11-02): a coder replaced the person's `test` script with one that ran only
 * its own file, and "test: passed" then meant that file passed. With `before` (the scripts as
 * they were before the task, `scriptsBefore`), a script the task changed or removed runs as it
 * was (`npm exec -c "<script>"`, which runs it as `npm run` does, with the folder's
 * `node_modules/.bin` on the PATH) under its own name, the changed one runs beside it as
 * "<name> (as this task changed it)" (not required), and the critic is told.
 */
export function projectChecks(
  root: string | undefined,
  before?: ScriptsBefore | null,
): ProjectChecks {
  const none: ProjectChecks = { checks: [], skipped: null, notes: [] };
  if (!root) return none;
  const file = join(root, "package.json");
  if (!existsSync(file)) {
    if (!before) return none;
    // The task removed package.json: its scripts as they were still judge the work.
    return withBefore(none, {}, before);
  }
  let pkg: {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  try {
    pkg = JSON.parse(readFileSync(file, "utf8")) as typeof pkg;
  } catch {
    return {
      checks: [],
      skipped: "the project's package.json could not be read, so its scripts were not run",
      notes: [],
    };
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const current: Record<string, string> = {};
  for (const n of PROJECT_SCRIPTS) {
    const v = realScript(n, scripts[n]);
    if (v) current[n] = v;
  }
  const names = PROJECT_SCRIPTS.filter(
    (n) => current[n] || (before && realScript(n, before.scripts[n])),
  );
  if (!names.length) return none;
  const needsInstall =
    Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
  if (needsInstall && !isDir(join(root, "node_modules")))
    return {
      checks: [],
      skipped: `${notRunWords(names)}: its dependencies are not installed in the task's folder (no node_modules)`,
      notes: [],
    };
  if (!before) return { checks: names.map((n) => npmRun(n)), skipped: null, notes: [] };
  return withBefore(none, current, before);
}

/** `npm run --silent <name>`: a script of the folder's package.json as a check. */
function npmRun(name: string, as = name, required = true): CheckCommand {
  return {
    name: as,
    argv: ["npm", "run", "--silent", name],
    timeoutMs: PROJECT_CHECK_TIMEOUT_MS,
    required,
  };
}

/** A script as it was before the task, run as `npm run` runs it (L-5). */
function npmExec(name: string, script: string): CheckCommand {
  return {
    name,
    argv: ["npm", "exec", "-c", script],
    timeoutMs: PROJECT_CHECK_TIMEOUT_MS,
    required: true,
  };
}

/** The suffix of the check that runs a script the way the task changed it (L-5). */
export const CHANGED_SCRIPT_SUFFIX = " (as this task changed it)";

/** The checks and notes when the scripts before the task are known (L-5). */
function withBefore(
  base: ProjectChecks,
  current: Record<string, string>,
  before: ScriptsBefore,
): ProjectChecks {
  const out: ProjectChecks = { ...base, checks: [], notes: [] };
  for (const n of PROJECT_SCRIPTS) {
    const now = current[n];
    const was = realScript(n, before.scripts[n]);
    if (now && (!was || was === now)) {
      out.checks.push(npmRun(n));
      if (!was) out.notes.push(`this task added the project's ${n} script (\`${now}\`)`);
    } else if (was && !now) {
      out.checks.push(npmExec(n, was));
      out.notes.push(
        `this task removed the project's ${n} script (\`${was}\`); the check "${n}" ran it as it was before the task`,
      );
    } else if (was && now) {
      out.checks.push(npmExec(n, was), npmRun(n, `${n}${CHANGED_SCRIPT_SUFFIX}`, false));
      out.notes.push(
        `this task changed the project's ${n} script from \`${was}\` to \`${now}\`; the check "${n}" ran it as it was before the task, and "${n}${CHANGED_SCRIPT_SUFFIX}" ran the new one`,
      );
    }
  }
  return out;
}

/** A script that is a check: a non-empty string that is not npm's "no test specified". */
function realScript(name: string, s: unknown): string | null {
  if (typeof s !== "string" || s.trim() === "") return null;
  if (name === "test" && NO_TEST.test(s)) return null;
  return s;
}

type RunFn = (argv: readonly string[], opts: RunOptions) => Promise<RunResult>;

/**
 * The `package.json` scripts of the task's folder before the task (L-5), from git: the folder's
 * first commit for the task ("Workspace before ... (task <id>)", written before its first run on
 * a project without a repository), else the merge base with the repository's default branch (a
 * task's branch). Null when git cannot tell; `{ scripts: {} }` when there was no package.json.
 */
export async function scriptsBefore(
  root: string,
  taskId: string,
  run: RunFn,
): Promise<ScriptsBefore | null> {
  const git = (args: string[]) =>
    run(["git", ...args], { cwd: root, allowFailure: true, timeoutMs: 30_000 });
  try {
    if ((await git(["rev-parse", "--is-inside-work-tree"])).code !== 0) return null;
    const mine = await git([
      "log",
      "--format=%H",
      "--fixed-strings",
      `--grep=(task ${taskId})`,
      "--reverse",
    ]);
    // An earlier version's first snapshot named the task's id in its message; since run L3 the
    // first snapshot is found by its ref (L3-run-11).
    let base = mine.code === 0 ? (mine.stdout.split(/\r?\n/).find((l) => l.trim()) ?? "") : "";
    if (!base) {
      const first = await git([
        "rev-parse",
        "--verify",
        "--quiet",
        `${firstSnapshotRef(taskId)}^{commit}`,
      ]);
      base = first.code === 0 ? first.stdout.trim() : "";
    }
    if (!base) {
      const origin = await git(["rev-parse", "--verify", "--quiet", "origin/HEAD"]);
      if (origin.code !== 0) return null;
      const mb = await git(["merge-base", "origin/HEAD", "HEAD"]);
      base = mb.code === 0 ? mb.stdout.trim() : "";
    }
    base = base.trim();
    if (!/^[0-9a-f]{7,64}$/i.test(base)) return null;
    const shown = await git(["show", `${base}:package.json`]);
    if (shown.code !== 0) return { scripts: {} };
    const pkg = JSON.parse(shown.stdout) as { scripts?: Record<string, unknown> };
    const scripts: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.scripts ?? {}))
      if (typeof v === "string") scripts[k] = v;
    return { scripts };
  } catch {
    return null;
  }
}

/** "the project's test was not run" / "the project's build, lint and test were not run". */
export function notRunWords(names: readonly string[]): string {
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  return `the project's ${list} ${names.length === 1 ? "was" : "were"} not run`;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The project's own tests in a language other than JavaScript (C-3, the owner's decision (1):
 * the project's build, lint and tests always run for a code task, whatever the language), found
 * by the files that mark them, run with the usual command in the review's sandbox lease:
 *
 * - Python (`pyproject.toml`, `pytest.ini`, `setup.cfg`, `setup.py`, `tox.ini` or `test_*.py` /
 *   `*_test.py` files, at the root or under `tests/`): `python3 -m pytest -q`, else, when pytest
 *   is not installed and the tests are `unittest` tests, `python3 -m unittest discover`;
 * - Rust (`Cargo.toml`): `cargo test --offline`;
 * - Go (`go.mod`): `go test ./...` with the module proxy off.
 *
 * - JavaScript (test files `*.test.js` / `*.spec.js`, `.mjs` and `.cjs` too, or the scripts of
 *   a `test/`, `tests/` or `__tests__/` folder) when the folder has no package.json, or one whose
 *   scripts name no real test and that has no dependencies: `node --test <the files>`, Node's
 *   own runner (L3-research-4, live check 3: a tester's node:test file and the README's `node
 *   --test` were never run, as Python's unittest is without a pyproject).
 *
 * A tool missing where the checks run is a "not run, because ..." line, never a failure; so is
 * a run that could not get its dependencies (the network is off during the checks). A project
 * whose test files no check runs (a JavaScript project whose package.json has dependencies and
 * names no test script, TypeScript tests with no test script) is told too (`untestedFiles`).
 */
export interface MarkerCheck {
  /** The check's name as the person reads it: "pytest", "unittest", "cargo test", "go test". */
  name: string;
  /** The language, for the "not run" line: "Python", "Rust", "Go". */
  language: string;
  /** The candidates, in order: the first whose probe starts runs. */
  candidates: {
    name: string;
    argv: string[];
    /** A command that exits 0 when the tool is there. */
    probe: string[];
    /** What is missing when the probe fails, in words: "pytest", "Python". */
    tool: string;
  }[];
  /** Environment for the run (`GOPROXY=off`, no bytecode caches). */
  env?: Record<string, string>;
  /**
   * Why a run did not test the work although it ran (it could not get its dependencies: the
   * network is off during the checks), from its output; null when its result stands.
   */
  notRunBecause?: (output: string, root: string) => string | null;
  /** Why a candidate list ran out, in words, when none starts ("pytest is not installed"). */
  missing: string;
}

/** Why a run that could not fetch what it needs did not test anything. */
const NO_DEPENDENCIES =
  "their dependencies are not on this computer, and the network is off during the checks";

/** Whether a Python module of that name is the project's own (a file or a folder of it). */
function ownPythonModule(root: string, name: string): boolean {
  return [`${name}.py`, name, `src/${name}.py`, `src/${name}`].some((p) =>
    existsSync(join(root, ...p.split("/"))),
  );
}

/** Python test files (relative paths), at the root or in a tests folder, at most a few levels down. */
function pythonTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 50) return;
      if (e.startsWith(".") || e === "node_modules" || e === "__pycache__" || e === "venv")
        continue;
      const p = join(dir, e);
      if (isDir(p)) {
        if (depth < 3) walk(p, `${prefix}${e}/`, depth + 1);
      } else if (/^test_.*\.py$|_test\.py$/.test(e)) out.push(`${prefix}${e}`);
    }
  };
  walk(root, "", 0);
  return out;
}

/** A JavaScript test file `node --test` runs as it is (no build step): `.js`, `.mjs`, `.cjs`. */
const JS_TEST = /\.(test|spec)\.[cm]?js$|^(test|tests|__tests__)\/[^/]+\.[cm]?js$/;
/** Any test file of a JavaScript or TypeScript project (`untestedFiles`). */
const ANY_JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$|^(test|tests|__tests__)\/[^/]+\.[cm]?[jt]s$/;
/** At most this many test files are named to `node --test` (the command line stays short). */
const MAX_NODE_TEST_FILES = 100;

/** The folder's package.json as the JavaScript checks read it; `unreadable` when it is not JSON. */
type PackageJson = {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};
function readPackageJson(root: string): PackageJson | null | "unreadable" {
  const file = join(root, "package.json");
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return pkg && typeof pkg === "object" && !Array.isArray(pkg)
      ? (pkg as PackageJson)
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * Whether `node --test` runs the folder's JavaScript tests (L3-research-4): no package.json, or
 * one whose scripts name no real test (npm's placeholder is none) and that has no dependencies (a
 * package.json with dependencies wants its own runner, which its test script would name).
 */
function nodeTestApplies(pkg: PackageJson | null | "unreadable"): boolean {
  if (pkg === "unreadable") return false;
  if (!pkg) return true;
  if (realScript("test", pkg.scripts?.test)) return false;
  return (
    Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length === 0
  );
}

/** A Node.js "cannot find" for a package (not the project's own file, not a built-in), or null. */
function missingPackage(output: string): string | null {
  const m = /Cannot find (?:module|package) '([^']+)'/.exec(output);
  const name = m?.[1];
  if (!name || /^(?:\.|\/|[A-Za-z]:[\\/]|node:|file:)/.test(name)) return null;
  const parts = name.split("/");
  return name.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? null);
}

/** The marker checks of the task's folder (C-3). */
export function markerChecks(root: string | undefined): MarkerCheck[] {
  if (!root || !isDir(root)) return [];
  const out: MarkerCheck[] = [];
  const has = (f: string) => existsSync(join(root, f));
  const pyTests = pythonTestFiles(root);
  // The test files decide (a marker alone, with no test in the folder, has nothing to run).
  if (pyTests.length) {
    const unittestStyle = pyTests.every((f) => {
      try {
        return /\bunittest\b/.test(readFileSync(join(root, ...f.split("/")), "utf8"));
      } catch {
        return false;
      }
    });
    const dir = pyTests.every((f) => f.startsWith("tests/"))
      ? "tests"
      : pyTests.every((f) => f.startsWith("test/"))
        ? "test"
        : ".";
    const pattern = pyTests.every((f) => /_test\.py$/.test(f)) ? "*_test.py" : "test*.py";
    const candidates: MarkerCheck["candidates"] = [];
    for (const py of ["python3", "python"])
      candidates.push({
        name: "pytest",
        argv: [py, "-m", "pytest", "-q", "-p", "no:cacheprovider"],
        probe: [py, "-m", "pytest", "--version"],
        tool: "pytest",
      });
    if (unittestStyle)
      for (const py of ["python3", "python"])
        candidates.push({
          name: "unittest",
          argv: [py, "-m", "unittest", "discover", "-s", dir, "-p", pattern],
          probe: [py, "-c", "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)"],
          tool: "Python",
        });
    out.push({
      name: "pytest",
      language: "Python",
      candidates,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
      notRunBecause: (output, dir) => {
        const m = /No module named '([^'.]+)/.exec(output);
        if (!m?.[1] || ownPythonModule(dir, m[1])) return null;
        return `they need the Python package ${m[1]}, which is not installed where the checks run`;
      },
      missing: unittestStyle
        ? "Python is not installed where the checks run"
        : "pytest is not installed where the checks run",
    });
  }
  if (has("Cargo.toml"))
    out.push({
      name: "cargo test",
      language: "Rust",
      candidates: [
        {
          name: "cargo test",
          argv: ["cargo", "test", "--offline"],
          probe: ["cargo", "--version"],
          tool: "Rust (cargo)",
        },
      ],
      // The build goes into the try's folder (removed after the review), never into the
      // project's own target/ that a later commit could pick up.
      env: { CARGO_TARGET_DIR: `${TRY_FOLDER}/cargo-target` },
      notRunBecause: (output) =>
        /attempting to make an HTTP request, but --offline|failed to download|no matching package named|failed to get `[^`]+` as a dependency|unable to update registry|failed to load source for dependency/i.test(
          output,
        )
          ? NO_DEPENDENCIES
          : null,
      missing: "Rust (cargo) is not installed where the checks run",
    });
  if (has("go.mod"))
    out.push({
      name: "go test",
      language: "Go",
      candidates: [
        { name: "go test", argv: ["go", "test", "./..."], probe: ["go", "version"], tool: "Go" },
      ],
      env: { GOPROXY: "off", GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod" },
      notRunBecause: (output) =>
        /module lookup disabled by GOPROXY=off|cannot find module providing package|missing go\.sum entry|go: downloading/i.test(
          output,
        )
          ? NO_DEPENDENCIES
          : null,
      missing: "Go is not installed where the checks run",
    });
  // L3-research-4: JavaScript tests with no test script to run them: Node's own runner, on the
  // files by name (a try's samples, node_modules and TypeScript stay out; the run is the same
  // every time).
  const jsTests = projectFileList(root, 400).filter((f) => JS_TEST.test(f));
  if (jsTests.length && nodeTestApplies(readPackageJson(root)))
    out.push({
      name: "node --test",
      language: "JavaScript",
      candidates: [
        {
          name: "node --test",
          argv: ["node", "--test", ...jsTests.slice(0, MAX_NODE_TEST_FILES)],
          probe: ["node", "-e", 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'],
          tool: "Node.js 18 or later",
        },
      ],
      notRunBecause: (output) => {
        const pkg = missingPackage(output);
        if (pkg) return `they need the package ${pkg}, which is not installed where the checks run`;
        if (
          /ReferenceError: (?:describe|it|test|expect|beforeEach|afterEach|beforeAll|afterAll|jest|vi) is not defined/.test(
            output,
          )
        )
          return "they are written for a test runner that is not installed (they use its describe, it or expect without importing them)";
        if (/^\s*(?:#|ℹ)\s*tests 0\b/m.test(output)) return "node --test found no tests in them";
        return null;
      },
      missing: "Node.js 18 or later is not installed where the checks run",
    });
  return out;
}

/**
 * JavaScript and TypeScript test files no check runs (C-3): the folder has `*.test.js` /
 * `*.spec.js` files (TypeScript and JSX too) or a `test/` / `__tests__/` folder of scripts, and
 * no test script runs them. The review says so instead of saying nothing. The JavaScript files
 * `node --test` runs (`markerChecks`, L3-research-4) are not among them: before, a folder with no
 * package.json was told "there is no package.json to run them" while its README said `node
 * --test`. What is left says what runs and what does not: TypeScript is not run by `node --test`,
 * and a package.json with dependencies names its own runner in a test script.
 */
export function untestedFiles(root: string | undefined): string | null {
  if (!root || !isDir(root)) return null;
  const all = projectFileList(root, 400).filter((f) => ANY_JS_TEST.test(f));
  if (!all.length) return null;
  const pkg = readPackageJson(root);
  if (pkg && pkg !== "unreadable" && realScript("test", pkg.scripts?.test)) return null;
  const byNode = nodeTestApplies(pkg);
  const files = byNode ? all.filter((f) => !JS_TEST.test(f)) : all;
  if (!files.length) return null;
  // W15-50: true now (design §5 rule 4): a folder with no package.json is told so, never that
  // "its package.json" names no test script (live check 2, RUN-13).
  const why =
    pkg === "unreadable"
      ? "its package.json cannot be read"
      : byNode
        ? `node --test runs only JavaScript files, and ${
            pkg
              ? "its package.json names no test script"
              : "there is no package.json with a test script"
          } for these`
        : "its package.json names no test script";
  const shown = files.slice(0, 3).join(", ");
  return `the project has test files (${shown}${files.length > 3 ? ", ..." : ""}) that no check ran: ${why}`;
}

/** At most this many paths are listed to the critic; it can list more itself. */
export const MAX_PROJECT_FILES = 200;

/**
 * The files of the task's folder as the critic's list (relative paths, forward slashes, at most
 * `MAX_PROJECT_FILES`), without `.git`, `node_modules` and other dot folders, and without the
 * project's Local only folder (merged-copy, ADR 0113: the person's own files, never evidence;
 * the run's copy is gone by the review, this keeps a stray one out too).
 */
export function projectFileList(root: string | undefined, max = MAX_PROJECT_FILES): string[] {
  if (!root || !isDir(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e === "node_modules" || e.startsWith(".")) continue;
      if (!prefix && e === LOCAL_ONLY_DIR) continue;
      const p = join(dir, e);
      if (isDir(p)) {
        if (depth < 4) walk(p, `${prefix}${e}/`, depth + 1);
      } else out.push(`${prefix}${e}`);
    }
  };
  walk(root, "", 0);
  return out;
}
