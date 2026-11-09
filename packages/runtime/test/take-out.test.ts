import type { GitHost, PullRequestInfo, TakeOutGitResult } from "@forerunner/capabilities";
import { SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { requestView } from "../src/daemon/views.ts";
import { TaskTakeOut } from "../src/loop/take-out.ts";
import { requestOpened } from "../src/notifications/producers.ts";

/**
 * TaskTakeOut (merged-actions) with the host and the git step stood in: a second press while
 * the first runs opens no second pull request, and a merge Forerunner has no record of (merged
 * before ADR 0111, or on GitHub before the watcher read it) gets one that keeps the take-out,
 * so the row says it after a restart. The git step itself is tested on the fake GitHub
 * (capabilities `take-out.test.ts`), the route and the screens in apps/ui.
 */
describe("TaskTakeOut", () => {
  async function world(
    opts: { title?: string; result?: (pushed: TakeOutGitResult) => TakeOutGitResult } = {},
  ) {
    const clock = new SimulatedClock("2026-11-08T10:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const human = await store.human.insert({ name: "Ada", email: "a@example.test" });
    const agent = await store.agent.insert({ name: "Alice", owner_human_id: human.id });
    const project = await store.project.insert({ name: "Shop", goal: "g", repos: ["o/shop"] });
    const task = await store.task.insert({
      project_id: project.id,
      title: opts.title ?? "Add the cart",
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
        const pushed: TakeOutGitResult = {
          kind: "pushed",
          branch: "fr/aaaa-add-the-cart-take-out",
          base: "main",
          repo: { owner: "o", name: "shop" },
          how: "squash",
          commits: ["m".repeat(40)],
        };
        return opts.result ? opts.result(pushed) : pushed;
      },
    };
    const takeOut = new TaskTakeOut({ store, host, git, humanId: human.id, agentId: agent.id });
    return { store, task, later, takeOut, opened, release, host, human };
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
        'Opened #9 to take "Add the cart" out: merge it to remove the work, or close it to keep the work. "Add the till" built on it: check it still works once #9 is merged.',
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
    // Merged on GitHub: the watcher's read of main's head settles it (no list of open pull
    // requests at hand: each open take-out is read from the host).
    (w.host as unknown as { getPullRequest: () => Promise<PullRequestInfo> }).getPullRequest =
      async () => ({ number: 9, merged: true, state: "closed" }) as unknown as PullRequestInfo;
    await w.takeOut.settle(w.task.project_id, null);
    expect((await w.store.mergeRecord.forTask(w.task.id))?.take_out_state).toBe("merged");
  });

  it("a pull request of one commit, whose squash and rebase git cannot tell apart, is said to be merged, not squash-merged (review of merged-actions)", async () => {
    const w = await world({ result: (pushed) => ({ ...pushed, sure: false }) });
    w.release();
    expect((await w.takeOut.takeOut(w.task.id)).state).toBe("opened");
    const body = String((w.opened[0] as { body: string }).body);
    expect(body).toContain("(#4, merged): it reverts that change");
    expect(body).not.toContain("squash");
  });

  it("a conflict files one notice whose title survives a colon in the task's title: the Inbox, Home and the notification read the whole title, then one sentence (review of merged-actions)", async () => {
    // The review's bench walk: "Write the README: what the page does and how to open it" read
    // as the Inbox title '"Write the README' with the rest of the title in the body, and as
    // Home's line 'Corner Shop: "Write the README'. Planner titles often hold a colon.
    const title = "Write the README: what the page does and how to open it";
    const w = await world({ title, result: () => ({ kind: "conflict", files: ["README.md"] }) });
    w.release();
    expect((await w.takeOut.takeOut(w.task.id)).state).toBe("conflict");
    // A second press files no second notice.
    await w.takeOut.takeOut(w.task.id);
    const open = await w.store.humanRequest.list({ status: "open" } as never, { limit: 10 });
    expect(open).toHaveLength(1);
    const row = open[0];
    if (!row) throw new Error("no notice");
    const view = requestView(row, "Corner Shop");
    expect(view.title).toBe(
      '"Write the README: what the page does and how to…" could not be taken out',
    );
    expect(view.body).toBe(
      "Later work changed the same lines in README.md: undo it on GitHub by hand, or ask in Chat for a task that does it.",
    );
    expect((view.choices ?? []).map((c) => [c.label, c.explain])).toEqual([
      ["Got it", "Closes this card; its work stays in main."],
    ]);
    expect(view.reply).toBe("none");
    // Home's Needs you line is the project's name and this title (HomePage.tsx).
    expect(`${view.projectName}: ${view.title}`).toBe(
      'Corner Shop: "Write the README: what the page does and how to…" could not be taken out',
    );
    // The notification is titled from the same words, the project's name first; its 60
    // characters shorten the quoted name, never what happened.
    const note = requestOpened(row, w.human.id, { projectName: "Corner Shop" });
    expect(note.title).toMatch(/^Corner Shop: "Write the [^"]*…" could not be taken out$/);
    expect(note.title.length).toBeLessThanOrEqual(60);
    // Answered: what happens next, not an echo of the click.
    const answered = requestView({ ...row, status: "answered", answer: "Got it" }, "Corner Shop");
    expect(answered.outcome).toBe(
      'Nothing changed: "Write the README: what the page does and how to…" stays in main.',
    );
  });
});
