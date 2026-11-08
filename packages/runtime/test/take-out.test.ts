import type { GitHost, PullRequestInfo, TakeOutGitResult } from "@forerunner/capabilities";
import { SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { TaskTakeOut } from "../src/loop/take-out.ts";

/**
 * TaskTakeOut (merged-actions) with the host and the git step stood in: a second press while
 * the first runs opens no second pull request, and a merge Forerunner has no record of (merged
 * before ADR 0111, or on GitHub before the watcher read it) gets one that keeps the take-out,
 * so the row says it after a restart. The git step itself is tested on the fake GitHub
 * (capabilities `take-out.test.ts`), the route and the screens in apps/ui.
 */
describe("TaskTakeOut", () => {
  async function world() {
    const clock = new SimulatedClock("2026-11-08T10:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const human = await store.human.insert({ name: "Ada", email: "a@example.test" });
    const agent = await store.agent.insert({ name: "Alice", owner_human_id: human.id });
    const project = await store.project.insert({ name: "Shop", goal: "g", repos: ["o/shop"] });
    const task = await store.task.insert({
      project_id: project.id,
      title: "Add the cart",
      status: "done",
      pr_url: "https://github.com/o/shop/pull/4",
      branch: "fr/aaaa-add-the-cart",
    });
    const later = await store.task.insert({
      project_id: project.id,
      title: "Add the till",
      status: "done",
      depends_on: [task.id],
    });
    const opened: unknown[] = [];
    const host = {
      getPullRequest: async () =>
        ({
          number: 4,
          merged: true,
          state: "closed",
          mergeCommitSha: "m".repeat(40),
          head: { ref: "fr/aaaa-add-the-cart", sha: "h".repeat(40) },
          base: { ref: "main", sha: "b".repeat(40) },
        }) as unknown as PullRequestInfo,
      createPullRequest: async (_repo: unknown, opts: unknown) => {
        opened.push(opts);
        return { number: 9, htmlUrl: "https://github.com/o/shop/pull/9" } as PullRequestInfo;
      },
    } as unknown as GitHost;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const git = {
      takeOut: async (): Promise<TakeOutGitResult> => {
        await gate;
        return {
          kind: "pushed",
          branch: "fr/aaaa-add-the-cart-take-out",
          base: "main",
          repo: { owner: "o", name: "shop" },
          how: "squash",
          commits: ["m".repeat(40)],
        };
      },
    };
    const takeOut = new TaskTakeOut({ store, host, git, humanId: human.id, agentId: agent.id });
    return { store, task, later, takeOut, opened, release };
  }

  it("a second press while the first runs is refused; one pull request is opened, naming the task built on it; a record is made for a merge that had none", async () => {
    const w = await world();
    const first = w.takeOut.takeOut(w.task.id);
    const second = await w.takeOut.takeOut(w.task.id);
    expect(second).toMatchObject({
      state: "refused",
      sentence: "Its work is being taken out now: the answer comes in a moment.",
    });
    w.release();
    expect(await first).toEqual({
      state: "opened",
      sentence:
        'Opened #9 to take "Add the cart" out. It waits for you to merge it. "Add the till" built on it: check it still works once #9 is merged.',
      number: 9,
      url: "https://github.com/o/shop/pull/9",
      builtOn: ["Add the till"],
    });
    expect(w.opened).toHaveLength(1);
    expect(w.opened[0]).toMatchObject({
      title: "Take out: Add the cart",
      head: "fr/aaaa-add-the-cart-take-out",
      base: "main",
    });
    expect(String((w.opened[0] as { body: string }).body)).toContain(
      "(#4, squash-merged): it reverts that change",
    );
    expect(await w.store.mergeRecord.forTask(w.task.id)).toMatchObject({
      state: "merged",
      merge_sha: "m".repeat(40),
      method: "squash",
      take_out_pr_number: 9,
      take_out_state: "open",
    });
    // Asked again once it is open: refused with what is going on.
    expect((await w.takeOut.takeOut(w.task.id)).sentence).toBe(
      '"Add the cart" is being taken out in #9: merge #9 to finish it.',
    );
  });
});
