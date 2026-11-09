import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../src/agent/tools.ts";
import { filesBlock, todayLine } from "../src/conversation/project-facts.ts";
import { readTools } from "../src/conversation/read-tools.ts";
import { scopeOf } from "../src/conversation/scope.ts";

/** Two humans on one store, each with a principal agent and projects of their own. */
async function twoHumans() {
  const clock = new SimulatedClock("2026-11-09T09:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const robin = (await store.human.insert({ name: "Robin", email: "robin@example.test" })).id;
  const mara = (await store.human.insert({ name: "Mara", email: "mara@example.test" })).id;
  const agent = async (name: string, owner: string) =>
    (await store.agent.insert({ name, owner_human_id: owner, kind: "principal" })).id;
  const alice = await agent("Alice", robin);
  const bob = await agent("Bob", mara);
  const project = async (name: string, settings: Record<string, unknown>) =>
    (
      await store.project.insert({
        name,
        goal: `${name} goal`,
        settings: settings as never,
        summary_cache: {
          last_session: { summary: `${name}: the last session wrote the secret page.` },
        },
      })
    ).id;
  const quote = await project("Quote Page", { members: [alice] });
  const shopFront = await project("Shop Front", { members: [alice] });
  const marasShop = await project("Mara's Garden", { members: [bob] });
  const shopBack = await project("Shop Back", { members: [bob] });
  const shared = await project("Shared Site", { members: [bob], shared_with: [robin] });
  for (const [p, title] of [
    [quote, "Style the page"],
    [marasShop, "Secret plan"],
    [shared, "Write the shared page"],
  ] as const)
    await store.task.insert({ project_id: p, title, outcome: `${title}.` });
  return { store, robin, mara, quote, shopFront, marasShop, shopBack, shared };
}

const toolCtx = { signal: new AbortController().signal } as unknown as ToolExecutionContext;

async function call(
  store: StateStore,
  deps: { humanId: string; projectId: string },
  name: string,
  input: Record<string, unknown>,
) {
  const tool = readTools({ store, ...deps }).find((t) => t.name === name);
  return (await tool?.execute(input as never, toolCtx)) ?? { content: "", isError: true };
}

describe("d1109-chat-guard, run C: chat reads only this person's records (CG-6, D3-17)", () => {
  it("scopeOf names the person's own projects and those shared with them, never another person's", async () => {
    const w = await twoHumans();
    const names = (await scopeOf(w.store, w.robin)).map((p) => p.name).sort();
    expect(names).toEqual(["Quote Page", "Shared Site", "Shop Front"]);
    const maras = (await scopeOf(w.store, w.mara)).map((p) => p.name).sort();
    expect(maras).toEqual(["Mara's Garden", "Shared Site", "Shop Back"]);
    await w.store.close();
  });

  it("tasks_list, task_get and session_last never read or name another person's project: it is 'No project is called ...'", async () => {
    const w = await twoHumans();
    const deps = { humanId: w.robin, projectId: w.quote };
    // At 7d6b34a projectOf found a project by name among every project on the store.
    for (const [name, input] of [
      ["tasks_list", { project: "Mara's Garden" }],
      ["task_get", { task: "Secret plan", project: "Mara's Garden" }],
      ["session_last", { project: "Mara's Garden" }],
      ["files_list", { project: "Mara's Garden" }],
    ] as const) {
      const r = await call(w.store, deps, name, input);
      expect(r.isError, name).toBe(true);
      expect(r.content, name).toBe(`No project is called "Mara's Garden".`);
    }
    // "Shop" is the person's own "Shop Front" only: Mara's "Shop Back" is never named.
    const shop = await call(w.store, deps, "tasks_list", { project: "Shop" });
    expect(shop.content).toContain("# Tasks of Shop Front");
    expect(shop.content).not.toContain("Shop Back");
    // A project shared with the person is theirs to read.
    const sharedTask = await call(w.store, deps, "task_get", {
      task: "Write the shared page",
      project: "Shared Site",
    });
    expect(sharedTask.isError).toBeFalsy();
    expect(sharedTask.content).toContain('Task "Write the shared page" of Shared Site');
    await w.store.close();
  });
});

describe("d1109-chat-guard, run C: the person's own day and time in the facts (CG-5, D3-6)", () => {
  it("says the weekday, the date and the time where the person is, with the zone", () => {
    expect(todayLine("Europe/Zurich", Date.parse("2026-11-09T22:30:00Z"))).toBe(
      "Monday 9 November 2026, 23:30 (Europe/Zurich)",
    );
    // At 7d6b34a the facts had only "now: 2026-11-09T22:30:00.000Z": in UTC it was still 22:30,
    // and "yesterday" or "on Monday" were the UTC's days.
    expect(todayLine("Pacific/Auckland", Date.parse("2026-11-09T22:30:00Z"))).toBe(
      "Tuesday 10 November 2026, 11:30 (Pacific/Auckland)",
    );
  });

  it("follows the clock change in the week of 26 October (summer time ends on the 25th)", () => {
    // 00:30 summer time (UTC+2) on Sunday 25 October, then 23:30 winter time (UTC+1) that night.
    expect(todayLine("Europe/Zurich", Date.parse("2026-10-24T22:30:00Z"))).toBe(
      "Sunday 25 October 2026, 00:30 (Europe/Zurich)",
    );
    expect(todayLine("Europe/Zurich", Date.parse("2026-10-25T22:30:00Z"))).toBe(
      "Sunday 25 October 2026, 23:30 (Europe/Zurich)",
    );
    expect(todayLine("Europe/Zurich", Date.parse("2026-10-26T10:00:00Z"))).toBe(
      "Monday 26 October 2026, 11:00 (Europe/Zurich)",
    );
  });

  it("a zone the platform does not know is read as UTC and says so", () => {
    expect(todayLine("Mars/Olympus", Date.parse("2026-11-09T22:30:00Z"))).toBe(
      "Monday 9 November 2026, 22:30 (UTC)",
    );
    expect(todayLine("", Date.parse("2026-11-09T22:30:00Z"))).toBe(
      "Monday 9 November 2026, 22:30 (UTC)",
    );
  });
});

/**
 * d1109-chat-guard, run C: the facts a chat turn is given, as units (ADR 0114). The composed
 * cases are in chat-guard.test.ts.
 */
describe("d1109-chat-guard, run C: # Your files from the app's merge records (CG-4, D3-8)", () => {
  it("names the repository and this computer's copy, then the merges that wait with their record's sentence, the ones going on, the merged, the closed and those without a record; never 'merges it on GitHub'", () => {
    const block = filesBlock("/home/robin/app", {
      fullName: "alice/app",
      waiting: [
        {
          title: "Style the page",
          url: "https://github.com/alice/app/pull/4",
          sentence: "#4 waits for you to merge it: press Merge on the Overview.",
        },
      ],
      merging: [
        {
          title: "Add the script",
          url: "https://github.com/alice/app/pull/5",
          sentence: "#5 merges when its checks pass.",
        },
      ],
      merged: [{ title: "Write the README", url: "https://github.com/alice/app/pull/3" }],
      closed: [{ title: "Old try", url: "https://github.com/alice/app/pull/2" }],
      unknown: [{ title: "First page", url: "https://github.com/alice/app/pull/1" }],
    });
    expect(block).toBe(
      [
        "# Your files",
        "The repository: alice/app. Each task's work is a pull request there; it is on the default branch once it is merged.",
        "This computer's copy of the default branch: /home/robin/app",
        'Waiting for your Merge: "Style the page": #4 waits for you to merge it: press Merge on the Overview.',
        'Merging by itself: "Add the script": #5 merges when its checks pass.',
        'Merged: "Write the README" https://github.com/alice/app/pull/3',
        'Closed without merging: "Old try" https://github.com/alice/app/pull/2',
        'Pull requests of finished tasks: "First page" https://github.com/alice/app/pull/1',
      ].join("\n"),
    );
    expect(block).not.toContain("merges it on GitHub");
  });

  // Review of d1109-chat-guard: the merges going on by themselves were cut at ten with no word
  // that more exist, while the waiting ones said "And N more".
  it("past ten, the waiting and the going-on merges each say how many more there are", () => {
    const many = (n: number, sentence: string) =>
      Array.from({ length: n }, (_, i) => ({
        title: `Task ${i + 1}`,
        url: `https://github.com/alice/app/pull/${i + 1}`,
        sentence,
      }));
    const block = filesBlock(null, {
      fullName: "alice/app",
      waiting: many(12, "waits for your Merge."),
      merging: many(13, "merges when its checks pass."),
      merged: [],
      closed: [],
      unknown: [],
    });
    expect(block).toContain("And 2 more waiting for your Merge.");
    expect(block).toContain("And 3 more merging by themselves.");
    expect(block.match(/^Merging by itself:/gm)).toHaveLength(10);
  });

  it("a folder project names its folder only", () => {
    expect(filesBlock("/home/robin/notes", null)).toBe(
      "# Your files\nThe project's folder: /home/robin/notes",
    );
  });
});
