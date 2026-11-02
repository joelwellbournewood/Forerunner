import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, renderApp } from "./helpers.tsx";

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
    // the page says where the work in pull requests is (ADR 0104).
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

describe("a project linked to a repository: its pull requests on the Overview (ADR 0104)", () => {
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
    expect(rows.map((r) => r.textContent)).toEqual([
      '"Index the documentation pages" · pull request #11Open',
    ]);
    expect(within(rows[0] as HTMLElement).getByTestId("pr-waiting-link")).toHaveAttribute(
      "href",
      "https://example.test/org/atlas/pull/11",
    );
    expect(within(files).getByTestId("prs-waiting")).toHaveTextContent(
      "Merging on GitHub puts the work into the default branch.",
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
      '"Create the page skeleton in index.html" · pull request #2Open',
      '"Style the page in styles.css" · pull request #3Open',
    ]);
    expect(within(files).getByTestId("prs-you")).toHaveTextContent("Accepted by you at sign-off");
    expect(titles(await group("prs-you"))).toEqual([
      '"Add the deploy script" · pull request #5Open',
    ]);
    expect(within(files).getByTestId("prs-not-reviewed")).toHaveTextContent(
      "Marked done without the critic's review",
    );
    expect(titles(await group("prs-not-reviewed"))).toEqual([
      '"Write the README" · pull request #4Open',
    ]);
    const docs = within(files).getByTestId("prs-docs");
    expect(docs).toHaveTextContent("Forerunner's docs, merge them when you like");
    expect(docs).not.toHaveTextContent("Reviewed");
    expect(titles(await group("prs-docs"))).toEqual([
      `"The project's docs from the plan" · pull request #1Open`,
      '"Project status (docs/status.md)" · pull request #6Open',
    ]);
    // Each one opens on GitHub.
    expect(within(docs).getAllByTestId("pr-waiting-link")[1]).toHaveAttribute(
      "href",
      "https://example.test/org/atlas/pull/6",
    );
  });

  it("no PR waiting says so; a git host that does not answer says that in words", async () => {
    const harness = createHarness();
    harness.daemon.state.pullRequests.proj_atlas = { waiting: [], error: null };
    const first = renderApp("/projects/proj_atlas", harness);
    expect(await screen.findByTestId("prs-none")).toHaveTextContent(
      "No pull request waits for you.",
    );
    first.unmount();
    harness.daemon.state.pullRequests.proj_atlas = {
      waiting: [],
      error:
        "GitHub did not answer, so the pull requests are not listed (fetch failed). Try again later.",
    };
    renderApp("/projects/proj_atlas", harness);
    expect(await screen.findByTestId("prs-error")).toHaveTextContent(
      "GitHub did not answer, so the pull requests are not listed",
    );
    expect(screen.queryByTestId("prs-none")).toBeNull();
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
