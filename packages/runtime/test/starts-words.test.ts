import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";

/**
 * d1109-starts-engine S-12 (ADR 0118): no screen, card, log line or chat sentence promises a
 * start that does not happen. Before run C these phrases were true (answers and waits started
 * sessions); now only the person starts one, so none may be said anywhere a person reads. The
 * check reads every source file of the runtime, the commands and the app (code, not comments).
 */
const ROOT = process.cwd();
const DIRS = ["packages/runtime/src", "packages/commands/src", "apps/ui/src"];
// "Planning waits until 15:40 (...) and starts by itself." stays: the plan the person asked for is
// drafted again at the reset (a planning call, no session).
const RETIRED = [
  "limit) and starts by itself",
  "a task whose first credential runs out waits for its reset and starts by itself",
  "start by themselves, or go on at once",
  "the tasks start by themselves",
  "it starts by itself then",
  "A session will pick it up",
  "a session will pick it up",
  "the next session can run it",
  "the next session works on it again",
  "a session starts for it.",
  "Starts a session that tries again",
  "waiting work starts by itself",
  "and a session runs it",
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** The file's code: line and block comments dropped (what a person can be shown). */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

describe("d1109-starts-engine S-12: no word promises a start that does not happen", () => {
  it("the retired start promises are said nowhere a person reads", () => {
    const found: string[] = [];
    for (const dir of DIRS)
      for (const f of files(join(ROOT, dir))) {
        const c = code(readFileSync(f, "utf8"));
        for (const phrase of RETIRED) if (c.includes(phrase)) found.push(`${f}: ${phrase}`);
      }
    expect(found).toEqual([]);
  });
});
