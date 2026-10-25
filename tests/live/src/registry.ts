import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ForerunnerError, join, normalizeNewlines } from "@forerunner/platform";

/**
 * The registry the live runtime loads: a copy of the repository registry with the coder's
 * frontmatter narrowed to the in-process file tools and small caps. The registry names Claude
 * Code tools (`cc:Read`, `cc:Write`, ...) for the Agent SDK driver; the in-process loop driver
 * the daemon composes offers a specialist only the tools whose names match its allowlist, so
 * a registry specialist run through `LoopTaskExecutor` would have no tools at all. The live
 * harness therefore hands the coder the built-in tools by name and keeps the prompt body as it
 * is (the prompt version records the changed hash). The caps are the harness's: a live task
 * may not spend more than its budget or run longer than its turns, whatever the prompt asks.
 */
export interface SpecialistOverrides {
  tools: string[];
  maxBudgetUsd: number;
  maxTurns: number;
  timeoutMinutes: number;
  requiresSandbox: boolean;
}

export const LIVE_CODER_OVERRIDES: SpecialistOverrides = {
  tools: ["read_file", "write_file", "list_dir"],
  maxBudgetUsd: 0.5,
  maxTurns: 12,
  timeoutMinutes: 5,
  requiresSandbox: false,
};

/**
 * The researcher for the D.13 timing run (`live-6-researcher`): the in-process file tools (the
 * registry's `cc:Read`/`cc:Grep`/`cc:Glob`/`cc:Write` narrowed to the three built-ins; no
 * `cc:WebFetch` or `cc:WebSearch`, the task reads local fixtures only) and caps small enough
 * for one bounded question: the registry's 40 minute timeout would outlast the harness's
 * 30 minute test timeout, and its USD 2.50 cap is far above what a one-file question needs.
 * The default tier and effort stay as the registry has them; that is what the run measures.
 */
export const LIVE_RESEARCHER_OVERRIDES: SpecialistOverrides = {
  tools: ["read_file", "write_file", "list_dir"],
  maxBudgetUsd: 0.5,
  maxTurns: 16,
  timeoutMinutes: 10,
  requiresSandbox: false,
};

/**
 * The coder for the subscription half (ADR 0044): the registry's Claude Code names as written,
 * `cc:Bash` included so the executor's withholding of it (no sandbox lease covers the
 * subprocess) is exercised and audited, under the same small caps as the API-key half. The
 * Agent SDK driver passes the names through; the loop driver, were it picked, maps them to the
 * built-ins (ADR 0043), so the copy runs on either driver.
 */
export const LIVE_SDK_CODER_OVERRIDES: SpecialistOverrides = {
  tools: ["cc:Read", "cc:Edit", "cc:MultiEdit", "cc:Write", "cc:Bash", "cc:Grep", "cc:Glob"],
  maxBudgetUsd: 0.5,
  maxTurns: 12,
  timeoutMinutes: 5,
  requiresSandbox: false,
};

const REPLACED_KEYS = new Set([
  "allowed_tools",
  "max_budget_usd",
  "max_turns",
  "timeout_minutes",
  "requires_sandbox",
]);

/** Rewrite the frontmatter keys the overrides cover; everything else, the prompt included, stays. */
export function patchSpecialistFrontmatter(text: string, o: SpecialistOverrides): string {
  const lines = normalizeNewlines(text).split("\n");
  if (lines[0] !== "---") {
    throw new ForerunnerError("validation", "specialist file does not start with frontmatter");
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new ForerunnerError("validation", "specialist frontmatter is not closed");
  const kept: string[] = [];
  let skippingList = false;
  for (const line of lines.slice(1, end)) {
    const key = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line)?.[1];
    if (key) {
      skippingList = REPLACED_KEYS.has(key);
      if (skippingList) continue;
      kept.push(line);
      continue;
    }
    // continuation lines (list items, indented values) belong to the last key
    if (skippingList) continue;
    kept.push(line);
  }
  const added = [
    "allowed_tools:",
    ...o.tools.map((t) => `  - ${t}`),
    `max_budget_usd: ${o.maxBudgetUsd}`,
    `max_turns: ${o.maxTurns}`,
    `timeout_minutes: ${o.timeoutMinutes}`,
    `requires_sandbox: ${o.requiresSandbox}`,
  ];
  return [lines[0], ...kept, ...added, "---", ...lines.slice(end + 1)].join("\n");
}

export interface PreparedRegistry {
  dir: string;
  patched: string[];
}

/**
 * Copy the registry to `targetDir` and patch the named specialists. The source is never
 * touched; the copy lives under the harness's temp root and dies with it.
 */
export function prepareLiveRegistry(
  sourceDir: string,
  targetDir: string,
  overrides: Record<string, SpecialistOverrides> = { coder: LIVE_CODER_OVERRIDES },
): PreparedRegistry {
  if (!existsSync(sourceDir)) {
    throw new ForerunnerError("not_found", `registry not found: ${sourceDir}`);
  }
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  const patched: string[] = [];
  for (const [name, o] of Object.entries(overrides)) {
    const file = join(targetDir, "specialists", name, "specialist.md");
    if (!existsSync(file)) {
      throw new ForerunnerError("not_found", `specialist ${name} not found in ${sourceDir}`);
    }
    writeFileSync(file, patchSpecialistFrontmatter(readFileSync(file, "utf8"), o), "utf8");
    patched.push(name);
  }
  return { dir: targetDir, patched };
}
