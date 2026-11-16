import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  type PreparedContext,
  preparedContextOf,
  preparedExplain,
} from "../src/session/prepared-work.ts";

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

/**
 * Fix-up of the review (S-9, design §5 rules 4 and 9): an Inbox option that prepares work says
 * what pressing it does when the card is shown, by the same steps `prepareWork` takes, in the same
 * order: the project's running session, the person's session waiting to go on, then the hands-off
 * setting (stopped, quiet hours, another session first), else the person's next Start.
 */
describe("d1109-starts-engine S-9: the explain of an option that prepares work", () => {
  const tryAgain = (ctx: PreparedContext) =>
    `Tries again with your note, if any; ${preparedExplain(ctx)}.`;
  it.each<[string, PreparedContext, string]>([
    ["nothing runs", {}, "it runs at your next Start"],
    ["another project's session runs", { running: "other" }, "it runs at your next Start"],
    [
      "the project's session runs",
      { running: "this_project", startsByItself: true },
      "it joins the running session if it fits",
    ],
    [
      "the person's session waits to go on",
      { continuationWaits: true, startsByItself: true },
      "it joins your session when it goes on, if it fits",
    ],
    ["the hands-off setting on", { startsByItself: true }, "a session starts for it by itself"],
    [
      "the hands-off setting on, another session runs",
      { startsByItself: true, running: "other" },
      "a session starts for it after the current one",
    ],
    [
      "the hands-off setting on, quiet hours now",
      { startsByItself: true, quiet: true, running: "other" },
      "a session starts for it after your quiet hours",
    ],
    [
      "the hands-off setting on, Stop all",
      { startsByItself: true, stopped: true, quiet: true },
      "it runs at your next Start once you allow sessions again",
    ],
  ])("%s", (_what, ctx, clause) => {
    expect(preparedExplain(ctx)).toBe(clause);
    expect(tryAgain(ctx).length).toBeLessThanOrEqual(100);
    expect(tryAgain(ctx)).not.toMatch(/CHF|USD|\$|[0-9a-f]{8}-/);
  });

  it("the facts are read as prepareWork meets them, read-only", async () => {
    const store = {
      project: {
        get: async (id: string) => ({
          id,
          settings: id === "p-hands-off" ? { start_by_itself: true } : {},
        }),
      },
    } as never;
    const live = { forProject: (id: string) => (id === "p-running" ? ({} as never) : undefined) };
    const deps = {
      store,
      live,
      startedFor: () => false,
      continuationWaits: async (id: string) => id === "p-waits",
      frozen: () => false,
      runningOther: (_a: string, id: string) => id !== "p-running",
      quietNow: async () => false,
    };
    expect(await preparedContextOf(deps, { agentId: "a", projectId: "p-running" })).toEqual({
      running: "this_project",
    });
    expect(await preparedContextOf(deps, { agentId: "a", projectId: "p-waits" })).toEqual({
      running: "other",
      continuationWaits: true,
    });
    expect(await preparedContextOf(deps, { agentId: "a", projectId: "p-hands-off" })).toEqual({
      running: "other",
      startsByItself: true,
    });
  });
});
