import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { CheckCommand } from "@forerunner/critic";
import { join } from "@forerunner/platform";

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
}

/**
 * The project's build, lint and tests from its `package.json` (`npm run <script>`), in the
 * order of `PROJECT_SCRIPTS`; none when the folder has no `package.json` or it cannot be read.
 */
export function projectChecks(root: string | undefined): ProjectChecks {
  if (!root) return { checks: [], skipped: null };
  const file = join(root, "package.json");
  if (!existsSync(file)) return { checks: [], skipped: null };
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
    };
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const names = PROJECT_SCRIPTS.filter((n) => {
    const s = scripts[n];
    return typeof s === "string" && s.trim() !== "" && !(n === "test" && NO_TEST.test(s));
  });
  if (!names.length) return { checks: [], skipped: null };
  const needsInstall =
    Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
  if (needsInstall && !isDir(join(root, "node_modules")))
    return {
      checks: [],
      skipped: `${notRunWords(names)}: its dependencies are not installed in the task's folder (no node_modules)`,
    };
  return {
    checks: names.map((n) => ({
      name: n,
      argv: ["npm", "run", "--silent", n],
      timeoutMs: PROJECT_CHECK_TIMEOUT_MS,
      required: true,
    })),
    skipped: null,
  };
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

/** At most this many paths are listed to the critic; it can list more itself. */
export const MAX_PROJECT_FILES = 200;

/**
 * The files of the task's folder as the critic's list (relative paths, forward slashes, at most
 * `MAX_PROJECT_FILES`), without `.git`, `node_modules` and other dot folders.
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
      const p = join(dir, e);
      if (isDir(p)) {
        if (depth < 4) walk(p, `${prefix}${e}/`, depth + 1);
      } else out.push(`${prefix}${e}`);
    }
  };
  walk(root, "", 0);
  return out;
}
