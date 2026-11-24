import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { EventSourceLike, StreamOptions } from "../src/api/sse.ts";
import { AppRoutes } from "../src/routes.tsx";
import { AppProvider } from "../src/store/context.tsx";
import { createHarness, type Harness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Today at this time on the person's clock (l4-cred-screens, L4-creds-20: Files writes times in
 * the person's zone, and the fake's person is in Zurich; before, in the computer's).
 */
function personToday(h: number, m: number): Date {
  const zone = { timeZone: "Europe/Zurich" };
  const day = new Date().toLocaleDateString("en-CA", zone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const guess = new Date(`${day}T${pad(h)}:${pad(m)}:00Z`);
  const [sh, sm] = guess
    .toLocaleTimeString("en-GB", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .split(":")
    .map(Number);
  return new Date(guess.getTime() - ((sh ?? 0) * 60 + (sm ?? 0) - (h * 60 + m)) * 60_000);
}

/** The daemon's `/events` stream from the fake daemon's listeners, open at once. */
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
    // Atlas is linked to org/atlas: the folder is this computer's copy, and the page says where
    // the work in pull requests is (ADR 0106). Not brought to what is merged yet (no time):
    // it claims nothing about merges (review of merged-copy).
    const line = await within(tab).findByTestId("files-repository");
    expect(line).toHaveTextContent(
      "This computer's copy of org/atlas. Work waiting in a pull request is on the Overview.",
    );
    expect(line).not.toHaveTextContent("as merged");
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

  it("a copy that stopped following what is merged says so and why, never 'As merged'; once it follows again the line says when (R-copystuck)", async () => {
    const harness = createHarness();
    const today = personToday(14, 5);
    const line =
      "You changed README.md in this copy, and a merge changed it too: move your change out of the way and the copy follows again.";
    harness.daemon.state.copies.proj_atlas = {
      updatedAt: today.toISOString(),
      localOnly: null,
      stopped: { reason: "changed", files: ["README.md"], line },
    };
    render(
      <AppProvider
        client={harness.client}
        store={harness.store}
        streamOptions={liveEvents(harness)}
      >
        <MemoryRouter initialEntries={["/projects/proj_atlas/files"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    const tab = await screen.findByTestId("files-tab");
    const said = await within(tab).findByTestId("files-repository");
    // W14-5 (polish-words): what happened, then what to do; the pull requests' line, which has
    // nothing to do with the stuck copy, is left out (it was three sentences).
    expect(said.textContent).toBe(
      `This computer's copy of org/atlas has not followed merges since 14:05. ${line}`,
    );
    expect(said).not.toHaveTextContent("As merged");
    // The person moved their change away; the next merge brought the copy up to date.
    const later = new Date(today);
    later.setMinutes(9);
    harness.daemon.state.copies.proj_atlas = { updatedAt: later.toISOString(), localOnly: null };
    for (const l of harness.daemon.state.listeners) l("project.changed", { id: "proj_atlas" });
    await waitFor(() =>
      expect(within(tab).getByTestId("files-repository")).toHaveTextContent(
        "This computer's copy of org/atlas. As merged on GitHub, updated 14:09.",
      ),
    );
  });

  it("a repository project's copy says when it is as merged on GitHub, lists Local only with its line and Open folder, and follows a merge without a reload (merged-copy, U-037)", async () => {
    // Before (2026-11-03, bench): a pull request merged on the git host stayed out of Files
    // until a session ended, the page never said when the copy was brought up to date, and
    // there was no folder of the person's own that Forerunner never uploads.
    const harness = createHarness();
    const today = personToday(14, 5);
    const copyDir = "/home/alice/.local/share/forerunner/worktrees/proj_atlas";
    harness.daemon.state.copies.proj_atlas = {
      updatedAt: today.toISOString(),
      localOnly: {
        folder: `${copyDir}/Local only`,
        line: "Never uploaded. Agents can read and change it.",
      },
    };
    const atlasFiles = harness.daemon.state.files.proj_atlas ?? [];
    atlasFiles.push({
      path: "Local only/notes.txt",
      content: "my notes",
      updatedAt: today.toISOString(),
    });
    const opened: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: { path: string }) => {
        if (cmd === "open_folder") opened.push(args.path);
        return null;
      },
    };
    const user = userEvent.setup();
    try {
      render(
        <AppProvider
          client={harness.client}
          store={harness.store}
          streamOptions={liveEvents(harness)}
        >
          <MemoryRouter initialEntries={["/projects/proj_atlas/files"]}>
            <AppRoutes />
          </MemoryRouter>
        </AppProvider>,
      );
      const tab = await screen.findByTestId("files-tab");
      expect(await within(tab).findByTestId("files-repository")).toHaveTextContent(
        "This computer's copy of org/atlas. As merged on GitHub, updated 14:05. Work waiting in a pull request is on the Overview.",
      );
      const local = within(tab).getByTestId("local-only");
      expect(within(local).getByTestId("local-only-line")).toHaveTextContent(
        "Local only · Never uploaded. Agents can read and change it.",
      );
      expect(within(local).getByTestId("local-only-folder-path")).toHaveTextContent(
        `${copyDir}/Local only`,
      );
      // Open folder opens the Local only folder itself, and says so.
      const open = within(local).getByTestId("local-only-folder-open");
      expect(open).toHaveAttribute("title", "Opens the Local only folder.");
      await user.click(open);
      await waitFor(() => expect(opened).toEqual([`${copyDir}/Local only`]));
      // Its files are listed with the others.
      expect(
        within(tab)
          .getAllByTestId("file-row")
          .map((r) => r.dataset.path),
      ).toContain("Local only/notes.txt");

      // A merge brought the copy up to date (the daemon says the project changed): the list
      // and the time follow without a reload.
      atlasFiles.push({
        path: "site/footer.html",
        content: "<footer></footer>",
        updatedAt: today.toISOString(),
      });
      const later = new Date(today);
      later.setMinutes(7);
      (harness.daemon.state.copies.proj_atlas ?? { updatedAt: null }).updatedAt =
        later.toISOString();
      for (const l of harness.daemon.state.listeners) l("project.changed", { id: "proj_atlas" });
      await waitFor(() =>
        expect(
          within(tab)
            .getAllByTestId("file-row")
            .map((r) => r.dataset.path),
        ).toContain("site/footer.html"),
      );
      expect(within(tab).getByTestId("files-repository")).toHaveTextContent(
        "As merged on GitHub, updated 14:07.",
      );
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it("a repository that already has a folder named Local only gets none, with one sentence (merged-copy)", async () => {
    const harness = createHarness();
    harness.daemon.state.copies.proj_atlas = {
      updatedAt: null,
      localOnly: {
        folder: null,
        line: "No Local only folder here: this repository already has a folder of that name.",
      },
    };
    renderApp("/projects/proj_atlas/files", harness);
    const local = await screen.findByTestId("local-only");
    expect(within(local).getByTestId("local-only-line")).toHaveTextContent(
      "No Local only folder here: this repository already has a folder of that name.",
    );
    expect(within(local).queryByTestId("local-only-folder")).toBeNull();
    // Not brought up to date yet: the line says what the folder is, without a time or a claim
    // about merges.
    expect(screen.getByTestId("files-repository")).toHaveTextContent(
      "This computer's copy of org/atlas. Work waiting in a pull request is on the Overview.",
    );
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
    // merge-in-app: each row has Merge (before: Open only, merging was GitHub's); merged-actions:
    // and Open this version (before: the PR could be looked at on GitHub only).
    expect(rows.map((r) => r.textContent)).toEqual([
      '"Index the documentation pages" · pull request #11OpenMergeOpen this version',
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
      '"Create the page skeleton in index.html" · pull request #2OpenMergeOpen this version',
      '"Style the page in styles.css" · pull request #3OpenMergeOpen this version',
    ]);
    expect(within(files).getByTestId("prs-you")).toHaveTextContent("Accepted by you at sign-off");
    expect(titles(await group("prs-you"))).toEqual([
      '"Add the deploy script" · pull request #5OpenMergeOpen this version',
    ]);
    expect(within(files).getByTestId("prs-not-reviewed")).toHaveTextContent(
      "Marked done without the critic's review",
    );
    expect(titles(await group("prs-not-reviewed"))).toEqual([
      '"Write the README" · pull request #4OpenMergeOpen this version',
    ]);
    const docs = within(files).getByTestId("prs-docs");
    expect(docs).toHaveTextContent("Forerunner's docs, merge them when you like");
    expect(docs).not.toHaveTextContent("Reviewed");
    expect(titles(await group("prs-docs"))).toEqual([
      `"The project's docs from the plan" · pull request #1OpenMergeOpen this version`,
      '"Project status (docs/status.md)" · pull request #6OpenMergeOpen this version',
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

describe("Open this version on a waiting pull request (merged-actions, the owner's decision of 2026-11-02)", () => {
  it("each waiting row offers Open this version with its line; a click sends the PR's number and the row shows the folder with its sentence and Open folder, which opens that folder; a second PR replaces it", async () => {
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        {
          kind: "task",
          taskId: "task_1",
          title: "Index the documentation pages",
          number: 11,
          url: "https://example.test/org/atlas/pull/11",
          branch: "fr/task_1",
          review: "critic",
          merge: { state: "ready", canMerge: true, sentence: null, first: [] },
        },
        {
          kind: "docs",
          taskId: null,
          title: "The project's standard docs",
          number: 12,
          url: "https://example.test/org/atlas/pull/12",
          branch: "fr/docs-scaffold",
          review: null,
          merge: { state: "ready", canMerge: true, sentence: null, first: [] },
        },
      ],
      error: null,
    };
    const opened: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: { path: string }) => {
        if (cmd === "open_folder") opened.push(args.path);
        return null;
      },
    };
    const user = userEvent.setup();
    try {
      renderApp("/projects/proj_atlas", harness);
      const files = await screen.findByTestId("your-files");
      const rows = await within(files).findAllByTestId("pr-waiting");
      const first = rows[0] as HTMLElement;
      // Before: the row offered Open (on GitHub) and Merge only.
      const button = within(first).getByTestId("pr-preview");
      expect(button).toHaveTextContent("Open this version");
      expect(button).toHaveAttribute(
        "title",
        "Puts its files in a folder on this computer, to try before you merge it.",
      );
      expect(within(rows[1] as HTMLElement).getByTestId("pr-preview")).toBeInTheDocument();
      expect(within(files).queryByTestId("pr-preview-block")).toBeNull();
      await user.click(button);
      const block = await within(first).findByTestId("pr-preview-block");
      expect(within(block).getByTestId("pr-preview-sentence")).toHaveTextContent(
        "#11 as it would be merged. Changes here are not kept.",
      );
      const folder = "/home/you/.forerunner/worktrees/docs/previews/proj_atlas/pr-11";
      expect(within(block).getByTestId("pr-preview-folder-path")).toHaveTextContent(folder);
      expect(postedCalls(harness, "/projects/proj_atlas/pull-requests/11/preview")).toHaveLength(1);
      // Open folder opens that folder, and says so on the button.
      const open = within(block).getByTestId("pr-preview-folder-open");
      expect(open).toHaveAttribute("title", "Opens #11's version on this computer.");
      await user.click(open);
      expect(opened).toEqual([folder]);
      // The docs pull request's version replaces it: one preview per project.
      await user.click(within(rows[1] as HTMLElement).getByTestId("pr-preview"));
      expect(
        await within(rows[1] as HTMLElement).findByTestId("pr-preview-sentence"),
      ).toHaveTextContent("#12 as it would be merged. Changes here are not kept.");
      await waitFor(() => expect(within(first).queryByTestId("pr-preview-block")).toBeNull());
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it("a pull request that no longer waits: the row says why, and no folder is shown", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const row = (await within(files).findAllByTestId("pr-waiting"))[0] as HTMLElement;
    // Merged on GitHub meanwhile: the daemon no longer lists it as waiting.
    const prs = harness.daemon.state.pullRequests.proj_atlas;
    if (prs) prs.waiting = [];
    await user.click(within(row).getByTestId("pr-preview"));
    expect(await within(row).findByTestId("pr-preview-error")).toHaveTextContent(
      "#11 does not wait to be merged: it may be merged or closed already.",
    );
    expect(within(row).queryByTestId("pr-preview-block")).toBeNull();
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
    // l4-starts-sessions (L4-money-208): the bar's words with the count (it read 'Working on').
    expect(await within(header).findByTestId("project-status")).toHaveTextContent(
      'The coder works on "Decide the versioning scheme" (1 of 3 done)',
    );
    expect(within(header).queryByTestId("start-session")).toBeNull();
    expect(within(header).getByTestId("open-running-session")).toHaveAttribute(
      "href",
      "/sessions/sess_live",
    );
    // Overview's Working now says the same and opens it.
    await userEvent.setup().click(screen.getByTestId("tab-summary"));
    // d1109-run-visible (V-3): in the run indicator's words, with its Stop.
    expect(await screen.findByTestId("overview-working")).toHaveTextContent(
      'Atlas · the coder works on "Decide the versioning scheme"',
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

/**
 * R-overviewcalls (leftovers7-merge): while a pull request waits for its checks (up to a day),
 * the Overview read the list again on every new copy of its project's card, and the project
 * list is read again for any project's change (a card in the Inbox, a session): every Overview
 * of a repository project asked GitHub four times for each such event.
 */
describe("the Overview reads its pull requests again only when its own project changes (R-overviewcalls)", () => {
  const waitingRow = (n: number, title: string) => ({
    kind: "task" as const,
    taskId: `task_${n}`,
    title,
    number: n,
    url: `https://example.test/org/atlas/pull/${n}`,
    branch: `fr/${n}`,
    review: "critic" as const,
    merge: {
      state: "waiting_checks" as const,
      canMerge: false,
      sentence: `#${n} merges when its checks pass.`,
      first: [],
    },
  });

  it("a row that waits for its checks: ten refreshes of the project list for other changes add no read; this project's change reads it again", async () => {
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [waitingRow(5, "Add the page")],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness, liveEvents(harness));
    const files = await screen.findByTestId("your-files");
    expect(await within(files).findByTestId("pr-merge-sentence")).toHaveTextContent(
      "#5 merges when its checks pass.",
    );
    await new Promise((r) => setTimeout(r, 500));
    const reads = harness.daemon.state.pullRequestReads.proj_atlas ?? 0;
    const listed = harness.daemon.state.projectListReads;
    // A card came and went ten times elsewhere: the project list is read again each time.
    for (let i = 0; i < 10; i++) {
      for (const l of harness.daemon.state.listeners)
        l("inbox.changed", { needsYouCount: i + 1, blockingCount: 0 });
      await new Promise((r) => setTimeout(r, 60));
    }
    await waitFor(() => expect(harness.daemon.state.projectListReads).toBeGreaterThan(listed + 3), {
      timeout: 10_000,
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(harness.daemon.state.pullRequestReads.proj_atlas ?? 0).toBe(reads);
    // This project changed (a merge the watcher's retry made): the list is read again.
    for (const l of harness.daemon.state.listeners) l("project.changed", { id: "proj_atlas" });
    await waitFor(
      () => expect(harness.daemon.state.pullRequestReads.proj_atlas ?? 0).toBeGreaterThan(reads),
      { timeout: 10_000 },
    );
  }, 30_000);
});

describe("the Overview's 'Research reads:' line follows the project (R-researchreads)", () => {
  it("after a change from the Overview, a later change made in chat shows on the line while the page is open", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(
      <AppProvider
        client={harness.client}
        store={harness.store}
        streamOptions={liveEvents(harness)}
      >
        <MemoryRouter initialEntries={["/projects/proj_atlas/summary"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    const line = await screen.findByTestId("research-reads");
    await user.click(within(line).getByTestId("research-reads-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    await user.type(within(dialog).getByTestId("web-access-never"), "facebook.com");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await within(dialog).findByTestId("command-done");
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(() =>
      expect(screen.getByTestId("research-reads-line")).toHaveTextContent(
        "Research reads: any public website, never facebook.com",
      ),
    );
    // Then the person narrows it in chat (Talk): the daemon stores the rule and says the project
    // changed. The line follows the daemon, not the value the Overview set.
    harness.daemon.state.settingValues["web_access:proj_atlas"] = {
      mode: "only",
      only: ["developer.mozilla.org"],
      never: [],
    };
    for (const l of harness.daemon.state.listeners) l("project.changed", { id: "proj_atlas" });
    await waitFor(
      () =>
        expect(screen.getByTestId("research-reads-line")).toHaveTextContent(
          "Research reads: only developer.mozilla.org",
        ),
      { timeout: 10_000 },
    );
  }, 30_000);
});

/**
 * leftovers7-tailrun, wave 13 (TR-9): the Overview kept its own line while the card still said
 * the line it had replaced; a later change elsewhere that restored exactly that earlier line
 * (Chat undoing the Overview's change) left the stale line showing.
 */
describe("leftovers7-tailrun, wave 13: the 'Research reads:' line shows a restored rule (TR-9)", () => {
  it("Overview change, then Chat restores the earlier rule: the line shows the restored rule", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(
      <AppProvider
        client={harness.client}
        store={harness.store}
        streamOptions={liveEvents(harness)}
      >
        <MemoryRouter initialEntries={["/projects/proj_atlas/summary"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    const line = await screen.findByTestId("research-reads");
    expect(within(line).getByTestId("research-reads-line")).toHaveTextContent(
      /^Research reads: any public website$/,
    );
    await user.click(within(line).getByTestId("research-reads-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    await user.type(within(dialog).getByTestId("web-access-never"), "facebook.com");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await within(dialog).findByTestId("command-done");
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(() =>
      expect(screen.getByTestId("research-reads-line")).toHaveTextContent(
        /^Research reads: any public website, never facebook\.com$/,
      ),
    );
    // Chat undoes it: the rule is the earlier one again, and the project changed.
    delete harness.daemon.state.settingValues["web_access:proj_atlas"];
    for (const l of harness.daemon.state.listeners) l("project.changed", { id: "proj_atlas" });
    // Before: the Overview's own line stayed, since the card said what it had replaced.
    await waitFor(
      () =>
        expect(screen.getByTestId("research-reads-line")).toHaveTextContent(
          /^Research reads: any public website$/,
        ),
      { timeout: 10_000 },
    );
  }, 30_000);
});

describe("w15-merge, wave 15", () => {
  it("a merge that waits for what is left in its task's folder says so on its row with the folder and Open folder, and offers no bare Merge (W15-05)", async () => {
    const harness = createHarness();
    const sentence =
      "#8 waits for changes left in its task's folder: take them out or redo the task.";
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        {
          kind: "task",
          taskId: "task_8",
          title: "Write the footer",
          number: 8,
          url: "https://example.test/org/atlas/pull/8",
          branch: "fr/8",
          review: "critic",
          merge: { state: "waiting_checks", canMerge: false, sentence, first: [] },
          folder: "/home/pat/.forerunner/worktrees/task_8",
        },
      ],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const row = await within(files).findByTestId("pr-waiting");
    expect(within(row).getByTestId("pr-merge-sentence")).toHaveTextContent(sentence);
    expect(within(row).getByTestId("pr-wait-folder-path")).toHaveTextContent(
      "/home/pat/.forerunner/worktrees/task_8",
    );
    expect(within(row).queryByTestId("pr-merge")).toBeNull();
    expect(within(row).queryByTestId("pr-merging")).toBeNull();
  });

  it("the task folder's Open folder says it opens the task's folder, not the project's (W15-05 fix-up)", async () => {
    const harness = createHarness();
    const folder = "/home/pat/.forerunner/worktrees/task_8";
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        {
          kind: "task",
          taskId: "task_8",
          title: "Write the footer",
          number: 8,
          url: "https://example.test/org/atlas/pull/8",
          branch: "fr/8",
          review: "critic",
          merge: {
            state: "waiting_checks",
            canMerge: false,
            sentence:
              "#8 waits for changes left in its task's folder: take them out or redo the task.",
            first: [],
          },
          folder,
        },
      ],
      error: null,
    };
    const opened: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: { path: string }) => {
        if (cmd === "open_folder") opened.push(args.path);
        return null;
      },
    };
    const user = userEvent.setup();
    try {
      renderApp("/projects/proj_atlas", harness);
      const files = await screen.findByTestId("your-files");
      const row = await within(files).findByTestId("pr-waiting");
      // Before: "Opens the project's folder." (FolderPath's default) on the task's folder.
      const open = within(row).getByTestId("pr-wait-folder-path-open");
      expect(open).toHaveAttribute("title", "Opens this task's folder on this computer.");
      await user.click(open);
      expect(opened).toEqual([folder]);
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});

describe("l3-merge, run L3", () => {
  const row = (
    n: number,
    title: string,
    kind: "task" | "cancelled" = "task",
    merge: Record<string, unknown> = {},
  ) => ({
    kind,
    taskId: `task_${n}`,
    title,
    number: n,
    url: `https://example.test/org/atlas/pull/${n}`,
    branch: `fr/${n}`,
    review: kind === "task" ? ("critic" as const) : null,
    merge: { state: "ready" as const, canMerge: true, sentence: null, first: [], ...merge },
  });

  it("L3-github-3: Merge on a pull request whose branch got a commit on GitHub shows the refusal at once, never 'Merging #40.'; the row then offers no Merge and says why", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const sentence =
      "#40 changed after the review: look at the new commits, then merge it yourself on GitHub, or redo the task from its row in Tasks.";
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [row(40, "Link trips page")],
      error: null,
    };
    harness.daemon.state.pullRequestPressFinds["proj_atlas#40"] = { row: "blocked", sentence };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    await user.click(await within(files).findByTestId("pr-merge"));
    expect(await within(files).findByRole("alert")).toHaveTextContent(sentence);
    expect(within(files).queryByTestId("merge-answer")).toBeNull();
    expect(within(files).queryByText(/Merging #40/)).toBeNull();
    expect(postedCalls(harness, "/projects/proj_atlas/pull-requests/40/merge")).toHaveLength(1);
    const shown = await within(files).findByTestId("pr-waiting");
    await waitFor(() =>
      expect(within(shown).getByTestId("pr-merge-sentence")).toHaveTextContent(sentence),
    );
    expect(within(shown).queryByTestId("pr-merge")).toBeNull();
  });

  it("L3-github-1: Merge on a pull request that still holds a closed one's work shows at once that it was rebuilt without it, merges nothing, and offers Merge again for after the person's look", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const sentence =
      "#48 was rebuilt without #46, which was closed. It was reviewed with #46's changes, so it waits for you: look at it, then merge it or redo the task.";
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [row(48, "Write kite/club-day.txt", "task", { first: [46] })],
      error: null,
    };
    harness.daemon.state.pullRequestPressFinds["proj_atlas#48"] = { row: "left_to_you", sentence };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    await user.click(await within(files).findByTestId("pr-merge"));
    expect(await within(files).findByRole("alert")).toHaveTextContent(sentence);
    expect(within(files).queryByText(/Merging #48/)).toBeNull();
    const shown = await within(files).findByTestId("pr-waiting");
    await waitFor(() =>
      expect(within(shown).getByTestId("pr-merge-sentence")).toHaveTextContent(sentence),
    );
    expect(within(shown).getByTestId("pr-merge")).toBeEnabled();
    expect(within(shown).queryByTestId("pr-merge-first")).toBeNull();
  });

  it("L3-github-10: a cancelled task's pull request still open on GitHub is named under its own heading with Open and no Merge; nothing else waits, so 'No pull request waits for you.' stays true", async () => {
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        row(43, "Write the About page in about.html", "cancelled", {
          state: "blocked",
          canMerge: false,
          sentence:
            "Its task was cancelled; #43 stays open on GitHub: close it there, or reopen the task.",
        }),
      ],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const block = await within(files).findByTestId("prs-cancelled");
    expect(block).toHaveTextContent("Cancelled, still open on GitHub");
    // l4-github-carried (L4-github-124 (b), L4-github-130): one pull request reads in the
    // singular, and the row's Close closes it (before: "Their tasks were cancelled and
    // Forerunner leaves them as they are: close them on GitHub, ...").
    expect(block).toHaveTextContent(
      "Its task was cancelled: close its pull request, or reopen the task in Tasks.",
    );
    const item = within(block).getByTestId("pr-cancelled");
    expect(item).toHaveTextContent('"Write the About page in about.html" · pull request #43');
    expect(within(item).getByTestId("pr-cancelled-link")).toHaveAttribute(
      "href",
      "https://example.test/org/atlas/pull/43",
    );
    expect(within(files).queryByTestId("pr-merge")).toBeNull();
    expect(within(files).queryByTestId("pr-waiting")).toBeNull();
    expect(within(files).getByTestId("prs-none")).toHaveTextContent(
      "No pull request waits for you.",
    );
  });

  it("L3-github-10: beside pull requests that wait for a Merge, the cancelled one is listed apart and only the others offer Merge", async () => {
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        row(40, "Link trips page"),
        row(43, "Write the About page in about.html", "cancelled", {
          state: "blocked",
          canMerge: false,
          sentence:
            "Its task was cancelled; #43 stays open on GitHub: close it there, or reopen the task.",
        }),
      ],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const waiting = await within(files).findByTestId("prs-waiting");
    expect(
      within(waiting)
        .getAllByTestId("pr-waiting")
        .map((r) => r.dataset.number),
    ).toEqual(["40"]);
    expect(within(waiting).getAllByTestId("pr-merge")).toHaveLength(1);
    expect(within(files).getByTestId("prs-cancelled")).toHaveTextContent("pull request #43");
  });
});

describe("l4-github-merge, run L4 (fixup)", () => {
  it("L4-github-124 (a): Merge on a pull request that builds on one closed on GitHub: the press is refused at once, and the Tasks row of the task it built on reads its pull request closed right after, with no poll", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const sentence =
      "#48 was rebuilt without #11, which was closed. It was reviewed with #11's changes, so it waits for you: look at it, then merge it or redo the task.";
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        {
          kind: "task",
          taskId: "task_48",
          title: "Write kite/club-day.txt",
          number: 48,
          url: "https://example.test/org/atlas/pull/48",
          branch: "fr/48",
          review: "critic",
          merge: { state: "ready", canMerge: true, sentence: null, first: [11] },
        },
      ],
      error: null,
    };
    // "Index the documentation pages" (#11) was closed on GitHub; no poll read it yet.
    harness.daemon.state.pullRequestPressFinds["proj_atlas#48"] = {
      row: "left_to_you",
      sentence,
      closedDependency: { taskId: "task_1", number: 11 },
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    await user.click(await within(files).findByTestId("pr-merge"));
    expect(await within(files).findByRole("alert")).toHaveTextContent(sentence);
    expect(postedCalls(harness, "/projects/proj_atlas/pull-requests/48/merge")).toHaveLength(1);
    // The Tasks tab, opened after the press: the closed one's row says so.
    await user.click(screen.getByTestId("tab-tasks"));
    await waitFor(() => {
      const row = screen
        .getAllByTestId("task-row")
        .find((r) => r.getAttribute("data-task-id") === "task_1") as HTMLElement;
      expect(within(row).getByTestId("task-status")).toHaveTextContent(
        "Accepted · pull request closed",
      );
    });
  });
});

describe("l4-github-carried, run L4", () => {
  const cancelledRow = (n: number, title: string) => ({
    kind: "cancelled" as const,
    taskId: `task_c${n}`,
    title,
    number: n,
    url: `https://example.test/org/atlas/pull/${n}`,
    branch: `fr/${n}`,
    review: null,
    merge: {
      state: "blocked" as const,
      canMerge: false,
      sentence: `Its task was cancelled; #${n} stays open on GitHub: close it there, or reopen the task.`,
      first: [],
    },
  });

  it("L4-github-130 (the owner's decision of 2026-11-18): Close beside Open on the 'Cancelled, still open on GitHub' row says what it does; one press closes that pull request (one close sent), the row goes and the answer says it can be reopened on GitHub", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [cancelledRow(43, "Write the About page in about.html")],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const block = await within(files).findByTestId("prs-cancelled");
    // L4-github-124 (b): one pull request, one sentence in the singular.
    expect(within(block).getByTestId("prs-cancelled-explain")).toHaveTextContent(
      "Its task was cancelled: close its pull request, or reopen the task in Tasks.",
    );
    const item = within(block).getByTestId("pr-cancelled");
    const close = within(item).getByTestId("pr-cancelled-close");
    expect(close).toHaveTextContent("Close");
    expect(close).toHaveAttribute(
      "title",
      "Closes this pull request on GitHub; you can reopen it there.",
    );
    // Beside Open, which still links the pull request on GitHub.
    expect(within(item).getByTestId("pr-cancelled-link")).toHaveAttribute(
      "href",
      "https://example.test/org/atlas/pull/43",
    );
    await user.click(close);
    expect(await within(files).findByTestId("pr-close-answer")).toHaveTextContent(
      "Closed #43 on GitHub; you can reopen it there.",
    );
    await waitFor(() => expect(within(files).queryByTestId("prs-cancelled")).toBeNull());
    expect(postedCalls(harness, "/projects/proj_atlas/pull-requests/43/close")).toHaveLength(1);
    expect(harness.daemon.state.pullRequestCloses).toEqual([
      { projectId: "proj_atlas", number: 43 },
    ]);
    expect(postedCalls(harness, "/projects/proj_atlas/pull-requests/43/merge")).toHaveLength(0);
  });

  it("L4-github-130: a Close GitHub does not answer says so in one sentence on the row, and the row stays with its Close", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [cancelledRow(43, "Write the About page in about.html")],
      error: null,
    };
    harness.daemon.state.pullRequestCloseFails["proj_atlas#43"] = "unreachable";
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const item = await within(files).findByTestId("pr-cancelled");
    await user.click(within(item).getByTestId("pr-cancelled-close"));
    expect(await within(files).findByTestId("pr-close-error")).toHaveTextContent(
      "GitHub did not answer, so #43 was not closed. Try again later.",
    );
    expect(within(files).queryByTestId("pr-close-answer")).toBeNull();
    expect(within(files).getByTestId("pr-cancelled")).toBeInTheDocument();
    expect(within(files).getByTestId("pr-cancelled-close")).toBeEnabled();
    expect(harness.daemon.state.pullRequestCloses).toEqual([]);
  });

  it("L4-github-124 (c): a pull request rebuilt without a closed one it built on is listed apart from 'Reviewed by the critic', with its Merge and line", async () => {
    const harness = createHarness();
    const sentence =
      "#48 was rebuilt without #11, which was closed. It was reviewed with #11's changes, so it waits for you: look at it, then merge it or redo the task.";
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [
        {
          kind: "task",
          taskId: "task_40",
          title: "Link trips page",
          number: 40,
          url: "https://example.test/org/atlas/pull/40",
          branch: "fr/40",
          review: "critic",
          merge: { state: "ready", canMerge: true, sentence: null, first: [] },
        },
        {
          kind: "task",
          taskId: "task_48",
          title: "Write kite/club-day.txt",
          number: 48,
          url: "https://example.test/org/atlas/pull/48",
          branch: "fr/48",
          review: "critic",
          rebuilt: true,
          merge: { state: "left_to_you", canMerge: true, sentence, first: [] },
        },
      ],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const critic = await within(files).findByTestId("prs-critic");
    expect(
      within(critic)
        .getAllByTestId("pr-waiting")
        .map((r) => r.dataset.number),
    ).toEqual(["40"]);
    const rebuilt = within(files).getByTestId("prs-rebuilt");
    expect(rebuilt).toHaveTextContent(
      "Rebuilt since the critic's review: look at each before you merge",
    );
    const row = within(rebuilt).getByTestId("pr-waiting");
    expect(row.dataset.number).toBe("48");
    expect(within(row).getByTestId("pr-merge-sentence")).toHaveTextContent(sentence);
    expect(within(row).getByTestId("pr-merge")).toBeEnabled();
  });

  it("L4-github-124 (b): two cancelled pull requests read in the plural, each with its own Close", async () => {
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [cancelledRow(43, "Write the About page"), cancelledRow(44, "Write the FAQ")],
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const files = await screen.findByTestId("your-files");
    const block = await within(files).findByTestId("prs-cancelled");
    expect(within(block).getByTestId("prs-cancelled-explain")).toHaveTextContent(
      "Their tasks were cancelled: close each pull request, or reopen its task in Tasks.",
    );
    expect(within(block).getAllByTestId("pr-cancelled-close")).toHaveLength(2);
  });

  const noPrLine = {
    kind: "elsewhere" as const,
    text: 'Took over org/atlas from "Kite club" here, but the docs pull request that names this project could not be opened, so GitHub still names "Kite club".',
    canTakeOver: false,
    takeOverLine: null,
    details: null,
    outcome: "took_over_no_pull_request" as const,
    tryAgainLine: "Tries again to open the docs pull request that names this project.",
  };

  it("L4e-left-1 (OQ-L4e-1's default): the take-over's no-pull-request line on the Overview has Try again with its consequence line; a refused press says why and keeps the line; a press that opens it says so and the line goes", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.repositoryOverview.proj_atlas = noPrLine;
    harness.daemon.state.takeOverRetryFails.proj_atlas = "refused";
    renderApp("/projects/proj_atlas", harness);
    const section = await screen.findByTestId("repository-elsewhere");
    expect(within(section).getByTestId("repository-elsewhere-line")).toHaveTextContent(
      noPrLine.text,
    );
    // Before: the line alone, with no next step (design §5 rule 8).
    const button = within(section).getByTestId("repository-try-again-button");
    expect(button).toHaveTextContent("Try again");
    expect(within(section).getByTestId("repository-try-again-line")).toHaveTextContent(
      "Tries again to open the docs pull request that names this project.",
    );
    expect(within(section).queryByTestId("repository-take-over")).toBeNull();
    await user.click(button);
    expect(await within(section).findByTestId("repository-try-again-refused")).toHaveTextContent(
      "The docs pull request still could not be opened: check that the saved GitHub token can push to org/atlas, then try again.",
    );
    expect(within(section).getByTestId("repository-elsewhere-line")).toBeInTheDocument();
    await user.click(within(section).getByTestId("repository-try-again-button"));
    expect(await screen.findByTestId("repository-try-again-opened")).toHaveTextContent(
      /^Opened #\d+: once you merge it, GitHub names this project\.$/,
    );
    await waitFor(() => expect(screen.queryByTestId("repository-elsewhere-line")).toBeNull());
    expect(postedCalls(harness, "/projects/proj_atlas/take-over/retry")).toHaveLength(2);
    // The bench walk (l4-github-carried): the docs pull request it opened is listed at once
    // under Waiting for you to merge (before: "No pull request waits for you." until a reload).
    const opened = Number(
      /#(\d+)/.exec(screen.getByTestId("repository-try-again-opened").textContent ?? "")?.[1],
    );
    await waitFor(() =>
      expect(screen.getByTestId("your-files")).toHaveTextContent(`pull request #${opened}`),
    );
  });

  it("L4e-left-4 (the session lead's decision of 2026-11-23) with L4e-left-1: Docs shows the take-over's outcome line with its Try again, and never OR-07's offer, which stays on the Overview with Take it over", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.repositoryOverview.proj_atlas = noPrLine;
    renderApp("/projects/proj_atlas/docs", harness);
    const docs = await screen.findByTestId("docs");
    expect(within(docs).getByTestId("docs-repository-line")).toHaveTextContent(noPrLine.text);
    await user.click(within(docs).getByTestId("docs-try-again-button"));
    expect(await within(docs).findByTestId("docs-try-again-opened")).toHaveTextContent(
      /^Opened #\d+: once you merge it, GitHub names this project\.$/,
    );
    await waitFor(() => expect(within(docs).queryByTestId("docs-repository-line")).toBeNull());
  });

  it("L4e-left-4: OR-07's offer ('... is also the Forerunner project ...') is not repeated on Docs", async () => {
    const harness = createHarness();
    harness.daemon.state.repositoryOverview.proj_atlas = {
      kind: "elsewhere",
      text: 'org/atlas is also the Forerunner project "Kite club", which is not on this computer.',
      canTakeOver: true,
      takeOverLine:
        "Makes this project the repository's project; Kite club's work stays on GitHub.",
      details: null,
    };
    renderApp("/projects/proj_atlas/docs", harness);
    const docs = await screen.findByTestId("docs");
    await within(docs).findByTestId("docs-present");
    // Before: the offer's line stood on Docs too, without its Take it over.
    expect(within(docs).queryByTestId("docs-repository-line")).toBeNull();
    expect(within(docs).queryByTestId("docs-try-again-button")).toBeNull();
  });

  it("L4c-left-4: after Add to on a project with tasks, 'Waiting for you: approve the plan' shows once on its page (the plan's banner), not again as the status line", async () => {
    // What Add to it leaves (onerepo-link.test.tsx "Add to it sends the brief to Atlas's plan"):
    // Atlas, which has tasks, with a plan from the brief waiting in the Inbox.
    const harness = createHarness();
    harness.daemon.state.intake.proj_atlas = {
      projectId: "proj_atlas",
      state: "pending",
      requestId: "req_intake",
      outcome: null,
      appliedAt: null,
      docs: null,
      error: null,
    };
    renderApp("/projects/proj_atlas", harness);
    const header = await screen.findByTestId("project-header");
    expect(header).toHaveTextContent("Atlas");
    const banner = await screen.findByTestId("intake-banner");
    expect(banner).toHaveAttribute("data-state", "pending");
    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.split("Waiting for you: approve the plan").length - 1).toBe(1);
    });
    expect(within(header).queryByTestId("project-status")).toBeNull();
  });
});
