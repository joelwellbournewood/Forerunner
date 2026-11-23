import { MemoryGitHost } from "@forerunner/capabilities";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../src/agent/tools.ts";
import { filesBlock, repositoryFacts } from "../src/conversation/project-facts.ts";
import { readTools } from "../src/conversation/read-tools.ts";
import { ProjectPullRequests } from "../src/daemon/pull-requests.ts";
import { balancedCut } from "../src/daemon/quoted-title.ts";
import { cutWords, leftOpenCardTitle } from "../src/daemon/request-words.ts";
import { rebuildSteps } from "../src/loop/merge.ts";
import { type LoopWorld, loopWorld } from "./loop-helpers.ts";

/**
 * l3-merge, run L3 (live check 3, 2026-11-15): the words and lists of the merge side that the
 * composed tests (`dependent-branches-merge.test.ts`, "l3-merge, run L3") do not reach.
 */
const worlds: LoopWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

async function world() {
  const w = await loopWorld({ replies: [] });
  worlds.push(w);
  await w.store.project.patch(w.project, { repos: ["o/app"] });
  return { w, project: await w.store.project.mustGet(w.project) };
}

const balanced = (s: string) => (s.match(/"/g) ?? []).length % 2 === 0;

describe("l3-merge, run L3", () => {
  it("L3-github-9: a card title never cuts inside the task title's own quotes; a short overrun keeps the title whole", () => {
    // Live: '"Link trips page from kite/index.html as "Our…" changed after the review'.
    const title = 'Link trips page from kite/index.html as "Our trips"';
    const card = { status: "head_moved" };
    expect(leftOpenCardTitle(card, title)).toBe(`"${title}" changed after the review`);
    // A long one is cut before the quote it would leave open.
    const long =
      'Link the trips page from kite/index.html as "Our trips around the lake and the hills"';
    const shown = leftOpenCardTitle(card, long);
    expect(shown).toBe('"Link the trips page from kite/index.html as…" changed after the review');
    expect(balanced(shown)).toBe(true);
    // A title with no quotes of its own is cut as before.
    const plain = "Write the welcome page for the club members in kite/welcome.html today";
    expect(leftOpenCardTitle(card, plain)).toBe(
      `"${cutWords(plain, 50)}" changed after the review`,
    );
  });

  it("L3-github-9's siblings: the balanced cut with each screen's own cutter", () => {
    const title = 'Link trips page from kite/index.html as "Our trips"';
    // Without slack (a notification's title is at most 60 characters): cut before the quote.
    expect(cutWords(title, 50)).toBe('Link trips page from kite/index.html as "Our…');
    expect(balancedCut(title, 50, cutWords, 0)).toBe("Link trips page from kite/index.html as…");
    for (const max of [20, 30, 40, 45, 50, 55])
      expect(balanced(balancedCut(title, max, cutWords, 0))).toBe(true);
    // A title that starts with its quote drops the quote marks rather than leave one open.
    expect(
      balancedCut(
        '"Our trips and the long list of all the places we went to" page',
        30,
        cutWords,
        0,
      ),
    ).not.toContain('"');
  });

  it("L3-github-7: a rebuild's card says a rebuild's steps, its own buttons included", () => {
    expect(rebuildSteps("rebuilt_without", 42, [35])).toEqual([
      "Look at #42 on GitHub: it no longer holds the changes of #35",
      "Then press Merge here, or Redo to do the task again from main",
    ]);
    expect(rebuildSteps("rebuilt_changed", 42, [35])).toEqual([
      "Look at #42 on GitHub: it was rebuilt onto main",
      "Then press Merge here, or Redo to do the task again from main",
    ]);
    // The conflicted rebuild's card offers Redo and Leave it open.
    expect(rebuildSteps("conflict", 42, [35, 36])).toEqual([
      "Redo does the task again from main, without the changes of #35 and #36",
      "Or merge #42 on GitHub if you want those changes too",
    ]);
  });

  it("L3-github-10: a cancelled task's pull request still open on GitHub is listed under its own kind with no Merge; a press and Open this version are refused; it goes once GitHub closes it", async () => {
    const { w, project } = await world();
    const host = new MemoryGitHost("alice");
    const repo = { owner: "o", name: "app" };
    await host.createRepo({ ...repo, private: true });
    const pr = await host.createPullRequest(repo, {
      title: "About page",
      body: "",
      head: "fr/about",
      base: "main",
    });
    const task = await w.addTask("Write the About page in about.html");
    await w.store.task.patch(task.id, { branch: "fr/about", pr_url: pr.htmlUrl });
    const row = await w.store.task.mustGet(task.id);
    await w.store.task.transition(task.id, row.version, "cancelled", "you cancelled it", {
      agentId: w.alice,
    });
    const approved: string[] = [];
    const prs = new ProjectPullRequests({
      store: w.store,
      host,
      merge: {
        approveInOrder: async (chain) => {
          approved.push(...chain.map((t) => t.id));
          return [];
        },
        mergeApproved: async () => [],
        mergeAsIs: async () => {
          throw new Error("never merged as it is");
        },
      },
      previews: {
        previewPullRequest: async () => {
          throw new Error("never previewed");
        },
        previewOf: () => null,
        dropPreview: async () => false,
      },
    });
    const sentence = `Its task was cancelled; #${pr.number} stays open on GitHub: close it there, or reopen the task.`;
    // Before (live check 3, G5): no row; "if (task.status !== "done") continue;".
    expect((await prs.view(project)).waiting).toEqual([
      {
        kind: "cancelled",
        taskId: task.id,
        title: "Write the About page in about.html",
        number: pr.number,
        url: pr.htmlUrl,
        branch: "fr/about",
        review: null,
        merge: { state: "blocked", canMerge: false, sentence, first: [] },
      },
    ]);
    expect(await prs.merge(project, pr.number, w.human)).toEqual({
      state: "refused",
      sentence,
      order: [],
    });
    expect(approved).toEqual([]);
    expect((await prs.preview(project, pr.number)).state).toBe("refused");
    // Closed on GitHub: no longer listed.
    await host.updatePullRequest(repo, pr.number, { state: "closed" });
    expect((await prs.view(project)).waiting).toEqual([]);
  });

  it("L3-github-10: the chat's '# Your files' facts and files_list name a cancelled task's pull request left open on GitHub", async () => {
    const { w, project } = await world();
    const url = "https://github.test/o/app/pull/43";
    const task = await w.addTask("Write the About page in about.html");
    await w.store.task.patch(task.id, { branch: "fr/about", pr_url: url });
    const row = await w.store.task.mustGet(task.id);
    await w.store.task.transition(task.id, row.version, "cancelled", "you cancelled it", {
      agentId: w.alice,
    });
    const facts = await repositoryFacts(w.store, project);
    expect(facts?.cancelled).toEqual([{ title: "Write the About page in about.html", url }]);
    // Before: the facts listed done tasks only, so "where are my files?" never named #43.
    expect(filesBlock(null, facts)).toContain(
      `Left open on GitHub when their task was cancelled (the person closes them there if not wanted): "Write the About page in about.html" ${url}`,
    );
    const filesList = readTools({
      store: w.store,
      projectId: w.project,
      humanId: w.human,
      openPullRequests: async () => [url],
    }).find((t) => t.name === "files_list");
    const out = await filesList?.execute(
      {} as never,
      { signal: new AbortController().signal } as unknown as ToolExecutionContext,
    );
    expect(out?.content).toContain(
      `Still open on GitHub although their task was cancelled (close them there if not wanted): "Write the About page in about.html" ${url}`,
    );
  });
});

describe("l4-github-merge, run L4", () => {
  it("L4-github-123: a title whose quoted part the word cut would drop whole is kept whole when it overruns a little; a long one is still cut before its quote", () => {
    // Live check 4: '"Write kite/ferry.txt about the ferry trip to…" changed after the review'.
    const t55 = 'Write kite/ferry.txt about the ferry trip to "Seal Bay"';
    expect(t55).toHaveLength(55);
    const card = { status: "head_moved" };
    expect(leftOpenCardTitle(card, t55)).toBe(`"${t55}" changed after the review`);
    const t53 = 'Write kite/trip.txt about the ferry run to "Seal Bay"';
    expect(t53).toHaveLength(53);
    expect(leftOpenCardTitle(card, t53)).toBe(`"${t53}" changed after the review`);
    const t70 = 'Write kite/ferry-notes.txt about the long ferry trip out to "Seal Bay"';
    expect(t70).toHaveLength(70);
    const shown = leftOpenCardTitle(card, t70);
    expect(shown).toBe('"Write kite/ferry-notes.txt about the long ferry…" changed after the review');
    expect(balanced(shown)).toBe(true);
    // Callers without slack (a notification's title) cut as before.
    expect(balancedCut(t55, 50, cutWords, 0)).toBe(cutWords(t55, 50));
  });
});
