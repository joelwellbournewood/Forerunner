import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { EventSourceLike, StreamOptions } from "../src/api/sse.ts";
import { createHarness, type Harness, postedCalls, renderApp } from "./helpers.tsx";

/** An `/events` EventSource wired to the fake daemon's listeners, open at once. */
function liveEvents(harness: Harness): StreamOptions {
  const factory = (_url: string): EventSourceLike => {
    const listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
    const fromDaemon = (event: string, data: unknown) => {
      for (const l of listeners.get(event) ?? []) l({ data: JSON.stringify(data) } as MessageEvent);
    };
    const es: EventSourceLike & { readyState: number } = {
      readyState: 0,
      onerror: null,
      onopen: null,
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        es.readyState = 2;
        harness.daemon.state.listeners.delete(fromDaemon);
      },
    };
    harness.daemon.state.listeners.add(fromDaemon);
    queueMicrotask(() => {
      es.readyState = 1;
      es.onopen?.(new Event("open"));
    });
    return es;
  };
  return { eventSource: factory, setTimer: () => 0, clearTimer: () => {} };
}

/**
 * The project page as a person uses it to see progress and results (design §3.4, §3.10): the
 * walks found no screen that showed the project's folder, Docs refusing index.html, a header
 * reading "planning · good · active · autonomy" while a session ran, Start session enabled
 * during a run, and a header that kept an old "needs you" until a reload.
 */
describe("Files (design §3.10)", () => {
  it("lists the project's folder as a tree with change dates and opens a text file inline", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/files");
    const tab = await screen.findByTestId("files-tab");
    expect(within(tab).getByTestId("folder-path")).toHaveTextContent(
      "/home/alice/.local/share/forerunner/worktrees/proj_atlas",
    );
    // Atlas is linked to org/atlas: the folder is this computer's copy of what is merged, and
    // the page says where the work in pull requests is (ADR 0106).
    expect(await within(tab).findByTestId("files-repository")).toHaveTextContent(
      "This computer's copy of org/atlas as merged. Work waiting in a pull request is on the Overview.",
    );
    // In a browser the path is to copy; Open folder is the desktop app's.
    expect(within(tab).getByTestId("folder-copy")).toHaveTextContent("Copy path");
    expect(within(tab).queryByTestId("folder-open")).toBeNull();
    const rows = within(tab).getAllByTestId("file-row");
    expect(rows.map((r) => r.dataset.path)).toEqual([
      "README.md",
      "site/index.html",
      "site/logo.png",
      "site/search.js",
    ]);
    expect(within(tab).getByTestId("file-dir")).toHaveTextContent("site/");
    await user.click(within(rows[1] as HTMLElement).getByText("index.html"));
    const view = await screen.findByTestId("file-view");
    expect(within(view).getByTestId("file-view-path")).toHaveTextContent("site/index.html");
    expect(await within(view).findByTestId("file-content")).toHaveTextContent(
      "<h1>Atlas docs</h1>",
    );
    await user.click(within(rows[2] as HTMLElement).getByText("logo.png"));
    expect(await screen.findByTestId("file-binary")).toHaveTextContent("Not a text file");
  });

  it("a link with ?path= opens that file; a project with nothing written says so", async () => {
    const first = renderApp("/projects/proj_atlas/files?path=README.md");
    expect(await screen.findByTestId("file-content")).toHaveTextContent("The documentation site.");
    first.unmount();
    renderApp("/projects/proj_beacon/files");
    expect(await screen.findByTestId("files-empty")).toHaveTextContent("Nothing written yet.");
  });

  it("the Overview's Your files names the folder and links to Files (a project's folder)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    // Atlas without its repository: a project whose work is in its folder on this computer.
    (harness.daemon.state.projects[0] as { repos: string[] }).repos = [];
    renderApp("/projects/proj_atlas/summary", harness);
    const files = await screen.findByTestId("your-files");
    expect(within(files).getByTestId("folder-path")).toHaveTextContent("proj_atlas");
    expect(within(files).queryByTestId("repository")).toBeNull();
    await user.click(within(files).getByText("See every file"));
    expect(await screen.findByTestId("files-tab")).toBeInTheDocument();
  });
});

describe("a project linked to a repository: its pull requests on the Overview (ADR 0106)", () => {
  // GitHub walk (2026-11-02): "5 reviewed pull requests wait for you to merge" on the session
  // page and the Overview led nowhere; the only links were the small "PR" on a Tasks row and
  // the drawer's; the repository was named nowhere on the project page.
  it("Your files names the repository with its link and lists each PR waiting for a merge with its link", async () => {
    const harness = createHarness();
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    expect(within(files).getByTestId("repository-link")).toHaveAttribute(
      "href",
      "https://github.com/org/atlas",
    );
    const rows = await within(files).findAllByTestId("pr-waiting");
    // merge-in-app: each row has Merge (before: Open only, merging was GitHub's).
    expect(rows.map((r) => r.textContent)).toEqual([
      '"Index the documentation pages" · pull request #11OpenMerge',
    ]);
    expect(within(rows[0] as HTMLElement).getByTestId("pr-waiting-link")).toHaveAttribute(
      "href",
      "https://example.test/org/atlas/pull/11",
    );
    expect(within(files).getByTestId("prs-waiting")).toHaveTextContent(
      "Merge puts the work into main with a merge commit; one that builds on others merges them first.",
    );
    expect(within(files).getByTestId("prs-critic")).toHaveTextContent("Reviewed by the critic");
    // No folder of this computer is offered as the project's files.
    expect(within(files).queryByTestId("folder-path")).toBeNull();
  });

  it("says who checked each waiting PR: the critic's, yours, one done without a review, and Forerunner's docs on their own line without a review claim", async () => {
    // Review (2026-11-02): every PR was listed under "Reviewed by the critic.", Forerunner's
    // status PR and the plan's docs PR too, which no critic reviewed, and a task marked done
    // without a review would have read the same.
    const harness = createHarness();
    const pr = (n: number, title: string, kind: "task" | "docs", review: string | null) => ({
      kind,
      taskId: kind === "task" ? `task_${n}` : null,
      title,
      number: n,
      url: `https://example.test/org/atlas/pull/${n}`,
      branch: `fr/${n}`,
      review: review as "critic" | "you" | "none" | null,
    });
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        pr(1, "The project's docs from the plan", "docs", null),
        pr(2, "Create the page skeleton in index.html", "task", "critic"),
        pr(3, "Style the page in styles.css", "task", "critic"),
        pr(4, "Write the README", "task", "none"),
        pr(5, "Add the deploy script", "task", "you"),
        pr(6, "Project status (docs/status.md)", "docs", null),
      ],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const group = async (id: string) =>
      (await within(files).findByTestId(id)).querySelectorAll("[data-testid=pr-waiting]");
    const titles = (rows: NodeListOf<Element>) => [...rows].map((r) => r.textContent);
    expect(within(files).getByTestId("prs-critic")).toHaveTextContent("Reviewed by the critic");
    expect(titles(await group("prs-critic"))).toEqual([
      '"Create the page skeleton in index.html" · pull request #2OpenMerge',
      '"Style the page in styles.css" · pull request #3OpenMerge',
    ]);
    expect(within(files).getByTestId("prs-you")).toHaveTextContent("Accepted by you at sign-off");
    expect(titles(await group("prs-you"))).toEqual([
      '"Add the deploy script" · pull request #5OpenMerge',
    ]);
    expect(within(files).getByTestId("prs-not-reviewed")).toHaveTextContent(
      "Marked done without the critic's review",
    );
    expect(titles(await group("prs-not-reviewed"))).toEqual([
      '"Write the README" · pull request #4OpenMerge',
    ]);
    const docs = within(files).getByTestId("prs-docs");
    expect(docs).toHaveTextContent("Forerunner's docs, merge them when you like");
    expect(docs).not.toHaveTextContent("Reviewed");
    expect(titles(await group("prs-docs"))).toEqual([
      `"The project's docs from the plan" · pull request #1OpenMerge`,
      '"Project status (docs/status.md)" · pull request #6OpenMerge',
    ]);
    // Each one opens on GitHub.
    expect(within(docs).getAllByTestId("pr-waiting-link")[1]).toHaveAttribute(
      "href",
      "https://example.test/org/atlas/pull/6",
    );
  });

  it("no PR waiting says so; a git host that does not answer says that in words, without the raw error; no token or a refused one offers Connect GitHub (C-56)", async () => {
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = { waiting: [], error: null };
    const first = renderApp("/projects/proj_atlas", harness);
    expect(await screen.findByTestId("prs-none")).toHaveTextContent(
      "No pull request waits for you.",
    );
    first.unmount();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [],
      error: "GitHub did not answer, so the pull requests are not listed. Try again later.",
      errorKind: "unreachable",
    };
    const second = renderApp("/projects/proj_atlas", harness);
    expect(await screen.findByTestId("prs-error")).toHaveTextContent(
      "GitHub did not answer, so the pull requests are not listed. Try again later.",
    );
    expect(screen.queryByTestId("prs-none")).toBeNull();
    expect(screen.queryByTestId("prs-connect")).toBeNull();
    second.unmount();
    // No token: GitHub was never asked, and the button that fixes it is there.
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [],
      error: "Add a GitHub token in Settings to see the pull requests.",
      errorKind: "no_token",
    };
    renderApp("/projects/proj_atlas", harness);
    expect(await screen.findByTestId("prs-error")).toHaveTextContent(
      "Add a GitHub token in Settings to see the pull requests.",
    );
    expect(screen.getByTestId("prs-connect")).toHaveTextContent("Connect GitHub");
    expect(screen.getByTestId("prs-connect")).toHaveAttribute("href", "/setup");
  });
});

describe("Merge in the app (merge-in-app, the owner's decision of 2026-11-02)", () => {
  const row = (n: number, title: string, merge: Record<string, unknown> = {}) => ({
    kind: "task" as const,
    taskId: `task_${n}`,
    title,
    number: n,
    url: `https://example.test/org/atlas/pull/${n}`,
    branch: `fr/${n}`,
    review: "critic" as const,
    merge: { state: "ready" as const, canMerge: true, sentence: null, first: [], ...merge },
  });

  it("says who merges with Change; Merge on the last of a chain is answered at once, shows Merging while the list is read again, then says what was merged; what was sent is the PR's number", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        row(2, "Add the page"),
        row(3, "Add the footer", { first: [2] }),
        row(4, "Add the test", { first: [2, 3] }),
      ],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    expect(await within(files).findByTestId("merge-mode")).toHaveTextContent(
      "Merging: you press Merge · Change",
    );
    expect(within(files).getByTestId("merge-mode-change")).toHaveAttribute(
      "href",
      "/settings#other-settings",
    );
    const rows = await within(files).findAllByTestId("pr-waiting");
    const last = rows[2] as HTMLElement;
    expect(within(last).getByTestId("pr-merge-first")).toHaveTextContent("Merges #2 and #3 first.");
    expect(within(last).getByTestId("pr-merge")).toHaveAttribute(
      "title",
      "Merges #2 and #3 first, then this one.",
    );
    await user.click(within(last).getByTestId("pr-merge"));
    expect(await within(files).findByTestId("merge-answer")).toHaveTextContent(
      "Merging #2, #3 and #4 in order.",
    );
    expect(postedCalls(harness, "/projects/proj_atlas/pull-requests/4/merge")).toHaveLength(1);
    // While the daemon merges, the rows say so and offer no second Merge.
    await waitFor(() => expect(within(files).getAllByTestId("pr-merging")).toHaveLength(3));
    expect(within(files).queryAllByTestId("pr-merge")).toEqual([]);
    // The list is read again until they are gone: merged.
    expect(await within(files).findByTestId("prs-none", {}, { timeout: 10_000 })).toHaveTextContent(
      "No pull request waits for you.",
    );
    expect(within(files).getByTestId("merge-answer")).toHaveTextContent("Merged #2, #3 and #4.");
  });

  it("a merge the step leaves to the person ends with its sentence on the row, and Merge is offered again", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.pullRequestMergeOutcome = {
      state: "left_to_you",
      sentence:
        "#11 waits for you: main changed since the review, and this repository has no automatic checks to test the two together. Press Merge if it should go in.",
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    await user.click(await within(files).findByTestId("pr-merge"));
    expect(
      await within(files).findByTestId("pr-merge-sentence", {}, { timeout: 10_000 }),
    ).toHaveTextContent("main changed since the review");
    expect(within(files).getByTestId("pr-merge")).toBeEnabled();
    // The line above says the outcome, not the click's "Merging #11." (review, 2026-11-08).
    expect(within(files).getByTestId("merge-answer")).toHaveTextContent(
      "#11 is not merged yet: the row below says why.",
    );
  });

  it("a chain whose Merge stops without merging anything says so above the rows, never 'Merging' (review W5: a failed check on the first)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [row(12, "Add the page"), row(13, "Add the footer", { first: [12] })],
      error: null,
    };
    harness.daemon.state.pullRequestMergeOutcome = {
      state: "blocked",
      sentence: "A check failed on #12 (ci/test): fix it, or merge it on GitHub.",
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const rows = await within(files).findAllByTestId("pr-waiting");
    await user.click(within(rows[1] as HTMLElement).getByTestId("pr-merge"));
    expect(await within(files).findByTestId("merge-answer")).toHaveTextContent(
      "Merging #12 and #13 in order.",
    );
    await waitFor(() => expect(within(files).getAllByTestId("pr-merge-sentence")).toHaveLength(2), {
      timeout: 10_000,
    });
    expect(within(files).queryAllByTestId("pr-merging")).toEqual([]);
    const answer = within(files).getByTestId("merge-answer");
    expect(answer).toHaveTextContent("#12 and #13 are not merged yet: each row below says why.");
    expect(answer).not.toHaveTextContent("Merging");
  });

  it("a Merge whose first pull request waits for its checks: the one after it says it waits its turn (not 'Merging…'), and the Overview stops reading the list (review W2, W4)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [row(5, "Add the page"), row(6, "Add the footer", { first: [5] })],
      error: null,
    };
    harness.daemon.state.pullRequestMergeOutcome = { state: "waiting_checks" };
    renderApp("/projects/proj_atlas", harness, liveEvents(harness));
    const files = await screen.findByTestId("your-files");
    const rows = await within(files).findAllByTestId("pr-waiting");
    await user.click(within(rows[1] as HTMLElement).getByTestId("pr-merge"));
    await waitFor(() => expect(within(files).getAllByTestId("pr-merge-sentence")).toHaveLength(2), {
      timeout: 10_000,
    });
    const after = within(files).getAllByTestId("pr-waiting");
    expect(within(after[0] as HTMLElement).getByTestId("pr-merge-sentence")).toHaveTextContent(
      "#5 merges when its checks pass.",
    );
    expect(within(after[1] as HTMLElement).getByTestId("pr-merge-sentence")).toHaveTextContent(
      "#6 merges after #5, once #5's checks pass.",
    );
    expect(within(files).queryAllByTestId("pr-merging")).toEqual([]);
    expect(within(files).getByTestId("merge-answer")).toHaveTextContent(
      "#5 and #6 are not merged yet: each row below says why.",
    );
    // Nothing is in flight: the list is not read again until the project changes (before, every
    // 1.5 s for as long as #5's checks ran: 19 reads in 30 s on the bench).
    const reads = harness.daemon.state.pullRequestReads.proj_atlas ?? 0;
    await new Promise((r) => setTimeout(r, 4_000));
    expect(harness.daemon.state.pullRequestReads.proj_atlas ?? 0).toBe(reads);
    // #5's checks pass and the watcher's retry merges both: the daemon says the project changed,
    // and the Overview reads the list again (bench: without this, the rows stayed until a reload).
    const prs = harness.daemon.state.pullRequests.proj_atlas;
    if (prs) prs.waiting = prs.waiting.filter((r) => r.number !== 5 && r.number !== 6);
    for (const l of harness.daemon.state.listeners) l("project.changed", { id: "proj_atlas" });
    expect(await within(files).findByTestId("prs-none", {}, { timeout: 10_000 })).toHaveTextContent(
      "No pull request waits for you.",
    );
    expect(within(files).getByTestId("merge-answer")).toHaveTextContent("Merged #5 and #6.");
  }, 30_000);

  it("a list that cannot be read after a Merge does not claim the merge: the line goes, the error says why", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    await user.click(await within(files).findByTestId("pr-merge"));
    expect(await within(files).findByTestId("merge-answer")).toHaveTextContent("Merging #11.");
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [],
      error: "GitHub did not answer, so the pull requests are not listed. Try again later.",
    };
    expect(
      await within(files).findByTestId("prs-error", {}, { timeout: 10_000 }),
    ).toHaveTextContent("GitHub did not answer");
    expect(within(files).queryByTestId("merge-answer")).toBeNull();
  });

  it("a row whose rules Forerunner cannot meet says why instead of a Merge; the automatic mode's line says so", async () => {
    const harness = createHarness();
    harness.daemon.state.settingValues["merge_mode:proj_atlas"] = "after_review";
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        row(7, "Add the page", {
          state: "blocked",
          canMerge: false,
          sentence:
            "This repository needs an approving review before merging, and GitHub does not let you approve your own pull request: merge it on GitHub once someone else approved it.",
        }),
        row(8, "Add the footer", {
          state: "waiting_checks",
          canMerge: false,
          sentence: "#8 merges when its checks pass.",
        }),
      ],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    expect(await within(files).findByTestId("merge-mode")).toHaveTextContent(
      "Merging: automatically after review · Change",
    );
    const rows = await within(files).findAllByTestId("pr-waiting");
    expect(within(files).queryAllByTestId("pr-merge")).toEqual([]);
    expect(within(rows[0] as HTMLElement).getByTestId("pr-merge-sentence")).toHaveTextContent(
      "needs an approving review before merging",
    );
    expect(within(rows[1] as HTMLElement).getByTestId("pr-merge-sentence")).toHaveTextContent(
      "#8 merges when its checks pass.",
    );
  });
});

describe("the project header (design §2, §3.4)", () => {
  it("while a session works: the sentence says on what, and Open running session replaces Start session", async () => {
    const harness = createHarness();
    harness.daemon.state.sessions.push({
      ...(harness.daemon.state.sessions[0] as (typeof harness.daemon.state.sessions)[0]),
      id: "sess_live",
      agentName: "Alice",
      status: "running",
      endedAt: null,
      startedAt: new Date().toISOString(),
      currentTask: { id: "task_3", title: "Decide the versioning scheme", specialist: "coder" },
    });
    // Nothing waits on the person, so the work comes first.
    for (const r of harness.daemon.state.requests) r.status = "answered";
    renderApp("/projects/proj_atlas/tasks", harness);
    const header = await screen.findByTestId("project-header");
    expect(await within(header).findByTestId("project-status")).toHaveTextContent(
      'Working on "Decide the versioning scheme" (1 of 3 done)',
    );
    expect(within(header).queryByTestId("start-session")).toBeNull();
    expect(within(header).getByTestId("open-running-session")).toHaveAttribute(
      "href",
      "/sessions/sess_live",
    );
    // Overview's Working now says the same and opens it.
    await userEvent.setup().click(screen.getByTestId("tab-summary"));
    expect(await screen.findByTestId("overview-working")).toHaveTextContent(
      'Alice is working on "Decide the versioning scheme"',
    );
  });

  it("follows the live card: when the session ends, Start session comes back without a reload", async () => {
    const harness = createHarness();
    const live = {
      ...(harness.daemon.state.sessions[0] as (typeof harness.daemon.state.sessions)[0]),
      id: "sess_live",
      status: "running",
      endedAt: null,
      currentTask: null,
    };
    harness.daemon.state.sessions.push(live);
    renderApp("/projects/proj_atlas/summary", harness, { pollIntervalMs: 40 });
    await screen.findByTestId("open-running-session");
    live.status = "completed";
    await waitFor(() => expect(screen.getByTestId("start-session")).toBeInTheDocument());
    expect(screen.queryByTestId("open-running-session")).toBeNull();
  });

  it("a tab keeps the address's filters: Tasks → Overview → Tasks keeps ?status=ready", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/tasks?status=ready");
    await screen.findByTestId("tab-panel-tasks");
    await user.click(screen.getByTestId("tab-summary"));
    await screen.findByTestId("tab-panel-summary");
    expect(screen.getByTestId("tab-tasks").getAttribute("href")).toBe(
      "/projects/proj_atlas/tasks?status=ready",
    );
  });
});

describe("the Overview's Last result is true now (C-54, design §5 rule 4)", () => {
  it("a task the session left for the person that moved on since gets a 'Since then' line", async () => {
    // Before: after Mark done anyway the Overview still read the session's '"Write the README
    // ..." needs your decision (Inbox).' with no such card in the Inbox.
    const harness = createHarness();
    const session = harness.daemon.state.sessions.find((s) => s.id === "sess_1");
    if (session) session.handoff = { blocked: ["task_1", "task_3"] };
    renderApp("/projects/proj_atlas", harness);
    const since = await screen.findByTestId("last-result-since");
    expect(
      within(since)
        .getAllByRole("listitem")
        .map((l) => l.textContent),
    ).toContain('Since then: "Index the documentation pages" is done.');
    expect(screen.getByTestId("last-result")).toHaveTextContent(
      "Indexed the docs and opened a PR for the search box.",
    );
  });
});
