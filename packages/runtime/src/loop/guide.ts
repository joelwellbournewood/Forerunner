import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { UNFINISHED_WORK_RULES } from "@forerunner/capabilities";
import type { GuideFacts, StatusIssueState } from "@forerunner/memory";
import { join } from "@forerunner/platform";
import type { JsonObject, ProjectRow } from "@forerunner/state";
import { mergeModeOf } from "./merge-mode.ts";
import { PROJECT_SCRIPTS } from "./project-checks.ts";

/**
 * The repository guide's facts (W8-guide-1, ADR 0121; the owner's decision of 2026-11-02:
 * "Every repository gets a standard guide for agents and people by default (with the docs
 * scaffold), kept current by Forerunner"): what `renderGuidePart` (`@forerunner/memory`)
 * renders `AGENTS.md` from, read only from what this install holds (the project's row and its
 * copy of the repository), never from a model and never from GitHub text. The same facts always
 * give the same guide; a changed fact (name, goal, default branch, who merges, the checks, the
 * status issue's state) gives a new one, which the next docs pull request carries.
 *
 * Only the Forerunner that made the project (the marker's writer) renders it; a project worked
 * on together with another Forerunner never does (D-W8-9, run C's OR-15).
 */

/**
 * Where the project's status is, for the guide (D-W8-44). The one place the status issue's
 * state comes in: `on` until w8-status-write's `statusIssuePolicy` lands, which then answers
 * `switched_off` (its switch in Settings) or `issues_off` (issues turned off on the repository)
 * and asks for a re-render when it changes (`ProjectDocs.refreshGuide`). The issue's number is
 * never a fact, so its creation changes nothing in the guide.
 */
export function guideStatusIssueState(_project: Pick<ProjectRow, "settings">): StatusIssueState {
  return "on";
}

/** The project's `settings.checks` commands as one line each (`argv` joined by spaces). */
function settingsChecks(settings: JsonObject | null | undefined): string[] {
  const raw = settings?.checks;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const argv = (entry as { argv?: unknown } | null)?.argv;
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string")) continue;
    out.push(argv.join(" "));
  }
  return out;
}

/**
 * The build, lint, typecheck and test scripts the folder's `package.json` names, as the critic
 * runs them (`npm run <name>`, `projectChecks`); npm's "no test specified" is no check.
 */
function packageChecks(dir: string | null): string[] {
  if (!dir) return [];
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return [];
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  return PROJECT_SCRIPTS.filter((n) => {
    const s = scripts[n];
    return (
      typeof s === "string" && s.trim() !== "" && !(n === "test" && /no test specified/i.test(s))
    );
  }).map((n) => `npm run ${n}`);
}

/**
 * A short fingerprint of the guide's facts, recorded on the project (`summary_cache.docs.
 * guide_key`) when its guide went out: the same facts give the same key, so a session end with
 * nothing changed reads no copy and calls no host, and a changed fact gives one docs pull request.
 */
export function guideKeyOf(facts: GuideFacts): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
}

/**
 * The guide's facts for `project`: `dir` is the folder whose `package.json` names the checks
 * (this computer's copy on the default branch, or the folder the doc set is written in), and
 * `defaultBranch` the repository's default branch (null for a project kept in a folder).
 */
export function guideFactsOf(
  project: Pick<ProjectRow, "name" | "goal" | "settings">,
  opts: { dir: string | null; defaultBranch: string | null },
): GuideFacts {
  return {
    name: project.name,
    goal: project.goal ?? null,
    repository:
      opts.defaultBranch === null
        ? null
        : {
            defaultBranch: opts.defaultBranch,
            mergedBy: mergeModeOf(project.settings),
            statusIssue: guideStatusIssueState(project),
          },
    checks: [...new Set([...settingsChecks(project.settings), ...packageChecks(opts.dir)])],
    unfinishedWork: UNFINISHED_WORK_RULES,
  };
}
