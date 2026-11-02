import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { EventSourceLike, StreamOptions } from "../src/api/sse.ts";
import {
  AGENT_ONLY_STATUSES as UI_AGENT_ONLY,
  TASK_TRANSITIONS as UI_TRANSITIONS,
} from "../src/lib/task-transitions.ts";
import { filterTasks, latestRunByTask } from "../src/pages/project/TasksTab.tsx";
import { AppRoutes } from "../src/routes.tsx";
import { AppProvider } from "../src/store/context.tsx";
import { fakeSandboxView } from "./fake-daemon.ts";
import { projectTaskViews } from "./fake-tasks.ts";
import { RUNS, TASKS } from "./fixtures.ts";
import { createHarness, type Harness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * The Tasks tab (design §3.5, core-experience.md; ADR 0102). The walks found the raw state
 * machine: "Needs me / Mark failed / Send to review / Mark done" buttons, `needs_human` badges,
 * "ready → needs_human" as a dialog's whole explanation, rows that never followed a running
 * session, a task that could not be opened, edited, reopened or redone, and "ready" on a task
 * that waited for another or for Docker. Each test clicks what the person clicks and asserts
 * what appears and what goes over the wire.
 */

const RAW = /needs_human|in_progress|in_review|claimed|tier \d|ready → |→/;

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

const rowOf = async (id: string) =>
  (await screen.findAllByTestId("task-row")).find(
    (r) => r.getAttribute("data-task-id") === id,
  ) as HTMLElement;
const actionsOf = (row: HTMLElement) =>
  within(row)
    .queryAllByTestId(/^action-/)
    .map((b) => b.textContent);

/** A task of the fixtures' project in a given state, added to the fake daemon. */
function addTask(
  harness: Harness,
  id: string,
  title: string,
  extra: Partial<(typeof TASKS)[number]> = {},
) {
  harness.daemon.state.tasks.push({
    ...(TASKS[2] as (typeof TASKS)[number]),
    id,
    title,
    riskTier: 1,
    prUrl: null,
    ...extra,
  });
}

describe("task transitions mirror", () => {
  it("matches the state package's TASK_TRANSITIONS graph", async () => {
    const state = await import("../../../packages/state/src/workflow.ts");
    expect(UI_TRANSITIONS).toEqual(state.TASK_TRANSITIONS);
  });

  it("matches the state package's agent-only statuses (U-013)", async () => {
    const task = await import("../../../packages/state/src/repos/task.ts");
    expect(UI_AGENT_ONLY).toEqual(task.AGENT_ONLY_STATUSES);
  });
});

describe("Tasks tab (design §3.5)", () => {
  it("filters by the status in words and searches what is on screen, never ids", () => {
    const views = projectTaskViews(TASKS, "proj_atlas", [], true, {
      pausedByPerson: new Set(),
      added: new Map(TASKS.map((t, i) => [t.id, i])),
    });
    expect(
      filterTasks(views, { status: "done", specialist: "", text: "" }).map((t) => t.id),
    ).toEqual(["task_1"]);
    expect(
      filterTasks(views, { status: "review", specialist: "", text: "" }).map((t) => t.id),
    ).toEqual(["task_2"]);
    expect(
      filterTasks(views, { status: "", specialist: "researcher", text: "" }).map((t) => t.id),
    ).toEqual(["task_3"]);
    expect(
      filterTasks(views, { status: "", specialist: "", text: "search BOX" }).map((t) => t.id),
    ).toEqual(["task_2"]);
    // Ids are shown nowhere, so the search does not match them.
    expect(filterTasks(views, { status: "", specialist: "", text: "task_" })).toEqual([]);
    expect(latestRunByTask(RUNS).get("task_2")?.verdict).toBe("revise");
  });

  it("rows in run order with the status in words; no raw state anywhere; plain filter words", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/tasks");
    const rows = await screen.findAllByTestId("task-row");
    // Run order: the medium-priority task first, then the done one and what waited on it.
    expect(rows.map((r) => r.getAttribute("data-task-id"))).toEqual(["task_3", "task_1", "task_2"]);
    const statuses = rows.map((r) => within(r).getByTestId("task-status").textContent);
    expect(statuses).toEqual(["Ready", "Done", "Being reviewed"]);
    expect(screen.getByTestId("tasks").textContent).not.toMatch(RAW);
    const review = within(rows[2] as HTMLElement);
    expect(review.getByText("Add the search box to the header")).toBeInTheDocument();
    expect(review.getByText("coder")).toBeInTheDocument();
    expect(review.getByText("CHF 3.60")).toBeInTheDocument();
    // The critic's call in plain words (U-074).
    expect(review.getByText("sent back")).toBeInTheDocument();
    // The review level in words: "Light review", never "tier 1".
    expect(rows[2]).toHaveTextContent("Light review · Low priority");
    // The filter offers the status words, and filters by them.
    const filter = screen.getByTestId("filter-status") as HTMLSelectElement;
    expect([...filter.options].map((o) => o.textContent)).toContain("Being reviewed");
    expect([...filter.options].map((o) => o.textContent).join(" ")).not.toMatch(RAW);
    await user.selectOptions(filter, "Ready");
    await waitFor(() => expect(screen.getAllByTestId("task-row")).toHaveLength(1));
    expect(screen.getAllByTestId("task-row")[0]).toHaveAttribute("data-task-id", "task_3");
  });

  it("a task waiting for another or for Docker says so, never 'ready' (design §2, U-079)", async () => {
    const harness = createHarness({ sandbox: { state: "not_running" } });
    addTask(harness, "task_wait", "Create notes/todo.md", {
      dependsOn: ["task_3"],
      specialist: null,
      cap: { usdMicro: 3_000_000, chfMicro: 2_400_000 },
    });
    addTask(harness, "task_full", "Add a LICENSE file (MIT)", { riskTier: 2 });
    addTask(harness, "task_me", "Confirm the hosting with me", { specialist: "person" });
    renderApp("/projects/proj_atlas/tasks", harness);
    const waiting = await rowOf("task_wait");
    expect(within(waiting).getByTestId("task-status")).toHaveTextContent(
      'Waiting for "Decide the versioning scheme"',
    );
    // No specialist chosen yet: the agent's choice, and the cap is the coder's (the planner's).
    expect(waiting).toHaveTextContent("Agent's choice");
    expect(within(waiting).getByTestId("task-cap")).toHaveTextContent(
      "each run stops at CHF 2.40 (coder limit)",
    );
    // A task for the person: "You", and no run limit (no specialist runs it).
    const mine = await rowOf("task_me");
    expect(mine).toHaveTextContent("You");
    expect(within(mine).queryByTestId("task-cap")).toBeNull();
    expect(within(await rowOf("task_full")).getByTestId("task-status")).toHaveTextContent(
      "Waiting for Docker",
    );
  });

  it("offers each status its own actions; none of Mark failed, Send to review, Mark done, Needs me", async () => {
    const harness = createHarness();
    addTask(harness, "t_draft", "A draft", { status: "draft" });
    addTask(harness, "t_run", "Running now", { status: "in_progress", claimedBy: "agent_alice" });
    addTask(harness, "t_fail", "It failed", { status: "failed", reason: "the model call failed" });
    addTask(harness, "t_gone", "Dropped", { status: "cancelled" });
    addTask(harness, "t_paused", "Paused one", { status: "needs_human" });
    harness.daemon.state.taskMeta.pausedByPerson.add("t_paused");
    renderApp("/projects/proj_atlas/tasks", harness);
    expect(actionsOf(await rowOf("task_3"))).toEqual(["Pause", "Cancel"]);
    expect(actionsOf(await rowOf("task_1"))).toEqual(["Redo"]);
    expect(actionsOf(await rowOf("task_2"))).toEqual(["Cancel"]);
    expect(actionsOf(await rowOf("t_draft"))).toEqual(["Make ready", "Cancel"]);
    expect(actionsOf(await rowOf("t_run"))).toEqual(["Stop", "Cancel"]);
    expect(actionsOf(await rowOf("t_fail"))).toEqual(["Try again", "Cancel"]);
    expect(actionsOf(await rowOf("t_gone"))).toEqual(["Reopen"]);
    expect(actionsOf(await rowOf("t_paused"))).toEqual(["Resume", "Cancel"]);
    const all = screen.getByTestId("task-table").textContent ?? "";
    for (const removed of ["Mark failed", "Send to review", "Mark done", "Needs me"])
      expect(all).not.toContain(removed);
    // The running row names its agent, never an id.
    const running = await rowOf("t_run");
    expect(within(running).getByTestId("task-status")).toHaveTextContent("Running");
    expect(within(running).getByTestId("task-running")).toHaveTextContent("Alice");
    expect(running.textContent).not.toMatch(/agent_alice|claimed by/);
    expect(within(await rowOf("t_fail")).getByTestId("task-status")).toHaveTextContent(
      "Failed: the model call failed",
    );
    // A finished task has no cap line.
    expect(within(await rowOf("task_1")).queryByTestId("task-cap")).toBeNull();
    expect(within(await rowOf("t_gone")).queryByTestId("task-cap")).toBeNull();
  });

  it("Pause says what it does, sends the action and the note, shows Paused by you, and Undo puts it back", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_notes", "Create notes/todo.md", { version: 1 });
    renderApp("/projects/proj_atlas/tasks", harness);
    await user.click(within(await rowOf("t_notes")).getByTestId("action-pause"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText('Pause "Create notes/todo.md"?')).toBeInTheDocument();
    expect(within(dialog).getByTestId("action-explain")).toHaveTextContent(
      "No session runs it until you press Resume.",
    );
    expect(within(dialog).getByText("Goes into the task's next brief.")).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(RAW);
    await user.type(within(dialog).getByTestId("action-note"), "Wait for the security review");
    await user.click(within(dialog).getByTestId("confirm-action"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/t_notes/action")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/t_notes/action")[0]?.body).toEqual({
      version: 1,
      action: "pause",
      note: "Wait for the security review",
    });
    await waitFor(async () =>
      expect(within(await rowOf("t_notes")).getByTestId("task-status")).toHaveTextContent(
        "Paused by you",
      ),
    );
    // One line, no "Undo." in it, one Undo button.
    const moved = screen.getByTestId("task-moved");
    expect(within(moved).getByTestId("task-moved-sentence")).toHaveTextContent(
      'Paused "Create notes/todo.md": no session runs it until you press Resume. Your note goes into its next brief.',
    );
    expect(moved.textContent).not.toContain("Undo.");
    expect(within(moved).getAllByRole("button")).toHaveLength(1);
    // The note is queued for the task's next brief.
    expect(harness.daemon.state.queue.map((q) => q.text)).toContain(
      'About "Create notes/todo.md": Wait for the security review',
    );
    await user.click(within(moved).getByTestId("task-moved-undo"));
    await waitFor(async () =>
      expect(within(await rowOf("t_notes")).getByTestId("task-status")).toHaveTextContent("Ready"),
    );
    expect(screen.getByTestId("task-moved-sentence")).toHaveTextContent(
      'Undone: the task "Create notes/todo.md" is ready again.',
    );
    // The note went back with the move.
    expect(harness.daemon.state.queue.find((q) => q.text.endsWith("security review"))?.status).toBe(
      "dismissed",
    );
  });

  it("Cancel names the tasks that wait on it; Reopen brings a cancelled task back", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_next", "Write the migration guide", { dependsOn: ["task_3"] });
    renderApp("/projects/proj_atlas/tasks", harness);
    await user.click(within(await rowOf("task_3")).getByTestId("action-cancel"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByTestId("action-explain")).toHaveTextContent(
      'Drops it. "Write the migration guide" waits on it and will be stuck.',
    );
    expect(within(dialog).getByTestId("dismiss-action")).toHaveTextContent("Keep task");
    await user.click(within(dialog).getByTestId("confirm-action"));
    await waitFor(async () =>
      expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent(
        "Cancelled",
      ),
    );
    expect(screen.getByTestId("task-moved-sentence")).toHaveTextContent(
      'Cancelled "Decide the versioning scheme". Its card in the Inbox was withdrawn. "Write the migration guide" waits on it and is stuck now.',
    );
    await waitFor(async () =>
      expect(within(await rowOf("t_next")).getByTestId("task-status")).toHaveTextContent(
        'Stuck: "Decide the versioning scheme" was cancelled',
      ),
    );
    await user.click(within(await rowOf("task_3")).getByTestId("action-reopen"));
    const reopen = await screen.findByTestId("action-dialog");
    expect(within(reopen).getByTestId("action-explain")).toHaveTextContent(
      "Brings it back as ready.",
    );
    await user.click(within(reopen).getByTestId("confirm-action"));
    await waitFor(async () =>
      expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent("Ready"),
    );
    expect(postedCalls(harness, "/tasks/task_3/action").map((c) => c.body)).toEqual([
      { version: 1, action: "cancel" },
      { version: 2, action: "reopen" },
    ]);
  });

  it("Cancel on a running task says its run stops and what it changed is removed, with Undo; a task with a pull request keeps it (ADR 0105)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_run", "Write the About page", {
      status: "in_progress",
      claimedBy: "agent_1",
    });
    addTask(harness, "t_pr", "Add the contact form", {
      status: "in_review",
      prUrl: "https://github.com/acme/site/pull/7",
    });
    renderApp("/projects/proj_atlas/tasks", harness);
    await user.click(within(await rowOf("t_run")).getByTestId("action-cancel"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByTestId("action-explain")).toHaveTextContent(
      "Drops it. Its run stops now and what it changed is removed; Undo brings it back.",
    );
    await user.click(within(dialog).getByTestId("confirm-action"));
    expect(await screen.findByTestId("task-moved-sentence")).toHaveTextContent(
      'Cancelled "Write the About page": its run stopped and what it changed is removed; Undo brings it back.',
    );
    expect(screen.getByTestId("task-moved-undo")).toBeInTheDocument();
    expect(postedCalls(harness, "/tasks/t_run/action").map((c) => c.body)).toEqual([
      { version: 1, action: "cancel" },
    ]);
    // Being reviewed, with a pull request: the review stops, the pull request stays open.
    await user.click(within(await rowOf("t_pr")).getByTestId("action-cancel"));
    const review = await screen.findByTestId("action-dialog");
    expect(within(review).getByTestId("action-explain")).toHaveTextContent(
      "Drops it. Its review stops now; its pull request stays open.",
    );
  });

  it("a task in review whose card waits reads Needs your decision; Cancel promises nothing about its files (phase C review)", async () => {
    // Its review failed in a session that ended (U-045): no review runs, its card waits. It
    // read "Being reviewed", and Cancel said its review stops and its work is removed.
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_failed_review", "Write the Contact page", { status: "in_review" });
    harness.daemon.state.requests.push({
      ...(harness.daemon.state.requests[0] as (typeof harness.daemon.state.requests)[number]),
      id: "req_review_failed",
      taskId: "t_failed_review",
      projectId: "proj_atlas",
      status: "open",
      why: '"Write the Contact page" could not be reviewed.',
      changeCard: { key: "critic:review_failed", task_id: "t_failed_review" },
    });
    renderApp("/projects/proj_atlas/tasks", harness);
    const row = await rowOf("t_failed_review");
    expect(within(row).getByTestId("task-status")).toHaveTextContent("Needs your decision");
    expect(actionsOf(row)).toEqual(["Answer", "Cancel"]);
    await user.click(within(row).getByTestId("action-cancel"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByTestId("action-explain")).toHaveTextContent(/^Drops it\.$/);
    await user.click(within(dialog).getByTestId("confirm-action"));
    expect(await screen.findByTestId("task-moved-sentence")).toHaveTextContent(
      'Cancelled "Write the Contact page". Its card in the Inbox was withdrawn.',
    );
  });

  it("Redo on a done task sends what to fix", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    await user.click(within(await rowOf("task_1")).getByTestId("action-redo"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByTestId("action-explain")).toHaveTextContent(
      "Reopens it; say what is wrong and the next attempt fixes it.",
    );
    await user.type(within(dialog).getByTestId("action-note"), "The index misses the FAQ page");
    await user.click(within(dialog).getByTestId("confirm-action"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_1/action")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/task_1/action")[0]?.body).toEqual({
      version: (TASKS[0] as (typeof TASKS)[number]).version,
      action: "redo",
      note: "The index misses the FAQ page",
    });
    await waitFor(async () =>
      expect(within(await rowOf("task_1")).getByTestId("task-status")).toHaveTextContent("Ready"),
    );
  });

  it("a row changed meanwhile: the dialog says what the task is now, once, and offers what fits", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    await user.click(within(await rowOf("task_3")).getByTestId("action-pause"));
    const dialog = await screen.findByTestId("action-dialog");
    // A session took the task meanwhile.
    const task = harness.daemon.state.tasks.find((t) => t.id === "task_3");
    if (!task) throw new Error("no task_3");
    task.status = "in_progress";
    task.claimedBy = "agent_alice";
    task.version += 1;
    await user.click(within(dialog).getByTestId("confirm-action"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This task changed: it is now Running.",
    );
    // Said once: not again as a banner over the table.
    expect(screen.getAllByText("This task changed: it is now Running.")).toHaveLength(1);
    // Pause is not offered for a running task: only Close.
    expect(within(dialog).queryByTestId("confirm-action")).toBeNull();
    expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent("Running");
  });

  it("Go ahead without on a task waiting for answers; Answer opens the Inbox", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_ask", "Decide where it is published", { status: "needs_human" });
    harness.daemon.state.requests.push({
      ...(harness.daemon.state.requests[0] as (typeof harness.daemon.state.requests)[number]),
      id: "req_ask",
      taskId: "t_ask",
      projectId: "proj_atlas",
      status: "open",
      why: "Where should the page be published?",
    });
    renderApp("/projects/proj_atlas/tasks", harness);
    const row = await rowOf("t_ask");
    expect(within(row).getByTestId("task-status")).toHaveTextContent("Needs your answer");
    expect(actionsOf(row)).toEqual(["Answer", "Go ahead without", "Cancel"]);
    await user.click(within(row).getByTestId("action-go_ahead"));
    const dialog = await screen.findByTestId("action-dialog");
    await user.click(within(dialog).getByTestId("confirm-action"));
    await waitFor(() =>
      expect(screen.getByTestId("task-moved-sentence")).toHaveTextContent(
        '"Decide where it is published" is ready again. Its card in the Inbox was withdrawn.',
      ),
    );
    expect(harness.daemon.state.requests.find((r) => r.id === "req_ask")?.status).toBe("withdrawn");
    // Undo puts it back as it was: it needs the answer again and its card is in the Inbox.
    await user.click(screen.getByTestId("task-moved-undo"));
    await waitFor(() =>
      expect(screen.getByTestId("task-moved-sentence")).toHaveTextContent(
        'Undone: the task "Decide where it is published" needs your answer again; its card is back in the Inbox.',
      ),
    );
    await waitFor(async () =>
      expect(within(await rowOf("t_ask")).getByTestId("task-status")).toHaveTextContent(
        "Needs your answer",
      ),
    );
    expect(harness.daemon.state.requests.find((r) => r.id === "req_ask")?.status).toBe("open");
  });

  it("a task only the person can do offers Answer and Cancel, never Go ahead without", async () => {
    const harness = createHarness();
    addTask(harness, "t_mine", "Choose the domain name", {
      status: "needs_human",
      specialist: "person",
    });
    harness.daemon.state.requests.push({
      ...(harness.daemon.state.requests[0] as (typeof harness.daemon.state.requests)[number]),
      id: "req_mine",
      taskId: "t_mine",
      projectId: "proj_atlas",
      status: "open",
      why: "Which domain name?",
    });
    renderApp("/projects/proj_atlas/tasks?task=t_mine", harness);
    const row = await rowOf("t_mine");
    expect(within(row).getByTestId("task-status")).toHaveTextContent("Needs your answer");
    expect(actionsOf(row)).toEqual(["Answer", "Cancel"]);
    const drawer = await screen.findByTestId("task-drawer");
    expect(within(drawer).queryByTestId("drawer-action-go_ahead")).toBeNull();
  });

  it("the drawer shows each run's own report; the critic's run is the review, with no report of its own", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const work = RUNS.find((r) => r.taskId === "task_2") as (typeof RUNS)[number];
    harness.daemon.state.runs.unshift({
      ...work,
      id: "run_review",
      specialist: "critic",
      createdAt: "2026-04-01T12:00:00.000Z",
    });
    renderApp("/projects/proj_atlas/tasks?task=task_2", harness);
    const drawer = await screen.findByTestId("task-drawer");
    const runs = await within(drawer).findAllByTestId("drawer-run");
    const review = runs.find((r) => r.getAttribute("data-kind") === "review") as HTMLElement;
    const own = runs.find((r) => r.getAttribute("data-kind") === "work") as HTMLElement;
    expect(review).toHaveTextContent(/^Review by the critic/);
    expect(review).not.toHaveTextContent("Wrote the page");
    expect(within(review).queryByTestId("drawer-files")).toBeNull();
    expect(own).toHaveTextContent(/^coder/);
    expect(own).toHaveTextContent("Wrote the page and checked it loads.");
    expect(within(own).getByTestId("drawer-files")).toHaveTextContent("index.html");
    await user.click(within(drawer).getByRole("button", { name: "Close" }));
  });

  it("a run's report with a specialist's markdown reads as text, its file names as typed", async () => {
    // The live run of 2026-11-01: specialists write "**Summary**:" and lists; the drawer showed
    // them as typed, as the session log did.
    const harness = createHarness();
    const work = RUNS.find((r) => r.taskId === "task_2") as (typeof RUNS)[number];
    const index = harness.daemon.state.runs.findIndex((r) => r.id === work.id);
    harness.daemon.state.runs[index] = {
      ...work,
      report:
        "**Summary**: wrote index.html and __tests__/search.test.js.\n- Typing searches\n- Results under 200 ms",
    } as (typeof RUNS)[number];
    renderApp("/projects/proj_atlas/tasks?task=task_2", harness);
    const drawer = await screen.findByTestId("task-drawer");
    const own = (await within(drawer).findAllByTestId("drawer-run")).find(
      (r) => r.getAttribute("data-kind") === "work",
    ) as HTMLElement;
    expect(own.textContent).not.toContain("**");
    expect(own).toHaveTextContent("Summary: wrote index.html and __tests__/search.test.js.");
    expect(within(own).getByText("Summary").tagName).toBe("STRONG");
    expect(
      within(own)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Typing searches", "Results under 200 ms"]);
  });

  it("the drawer shows what a task asks for and its runs; Edit lowers the review level and the row follows", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ sandbox: { state: "not_running" } });
    renderApp("/projects/proj_atlas/tasks", harness);
    // task_3 is a full review on a computer without Docker.
    expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent(
      "Waiting for Docker",
    );
    await user.click(within(await rowOf("task_2")).getByTestId("task-title"));
    let drawer = await screen.findByTestId("task-drawer");
    expect(await within(drawer).findByTestId("drawer-asks")).toHaveTextContent(
      "Typing in the header searches the index.",
    );
    expect(within(drawer).getByTestId("drawer-criteria")).toHaveTextContent(
      "Results in under 200 ms",
    );
    expect(within(drawer).getAllByTestId("drawer-run")[0]).toHaveTextContent("coder");
    expect(within(drawer).getByTestId("drawer-review")).toHaveTextContent(
      "The critic sent it back for changes.",
    );
    expect(within(drawer).getByTestId("drawer-waits")).toHaveTextContent(
      '"Index the documentation pages": Done',
    );
    await user.click(within(drawer).getByRole("button", { name: "Close" }));
    await user.click(within(await rowOf("task_3")).getByTestId("task-title"));
    drawer = await screen.findByTestId("task-drawer");
    // Every action of its status with its explanation beside it.
    const actions = await within(drawer).findByTestId("drawer-actions");
    expect(within(actions).getByTestId("drawer-action-edit").closest("li")).toHaveTextContent(
      "EditChange the wording, priority, budget, review level or specialist.",
    );
    await user.click(within(drawer).getByTestId("drawer-action-edit"));
    const form = await within(drawer).findByTestId("edit-task-form");
    const level = within(form).getByTestId("edit-risk-tier") as HTMLSelectElement;
    expect([...level.options].map((o) => o.textContent)).toContain(
      "Full review: needs Docker, not running on this computer",
    );
    expect(within(form).getByTestId("edit-docker-note")).toBeInTheDocument();
    await user.selectOptions(
      level,
      "Light review: the critic reads the work, nothing runs in isolation",
    );
    await user.click(within(form).getByTestId("save-task"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_3")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/task_3")[0]).toMatchObject({
      method: "PUT",
      body: expect.objectContaining({ version: 1, riskTier: 1 }),
    });
    await waitFor(async () =>
      expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent("Ready"),
    );
    expect(screen.getByTestId("task-moved-sentence")).toHaveTextContent(
      'Changed "Decide the versioning scheme": review level to Light review.',
    );
  });

  it("Edit keeps a deploy at the full review and says so when Save raises it; a level left as it is goes back as stored (ADR 0104)", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ sandbox: { state: "not_running" } });
    const coder = harness.daemon.state.modelSettings.specialists[0];
    if (coder)
      harness.daemon.state.modelSettings.specialists.push({ ...coder, name: "ops-deploy" });
    // A deploy stored at the light review (as New task could make one) and a planner's tier 0.
    addTask(harness, "task_deploy", "Deploy the site", {
      status: "ready",
      riskTier: 1,
      specialist: "ops-deploy",
    });
    addTask(harness, "task_zero", "Write the changelog", {
      status: "ready",
      riskTier: 0,
      specialist: "coder",
    });
    renderApp("/projects/proj_atlas/tasks", harness);
    const openEdit = async (id: string) => {
      await user.click(within(await rowOf(id)).getByTestId("task-title"));
      const drawer = await screen.findByTestId("task-drawer");
      await user.click(await within(drawer).findByTestId("drawer-action-edit"));
      return { drawer, form: await within(drawer).findByTestId("edit-task-form") };
    };

    // The deploy: only the full review levels, the full review shown, and what Save does said.
    let { drawer, form } = await openEdit("task_deploy");
    let level = within(form).getByTestId("edit-risk-tier") as HTMLSelectElement;
    expect([...level.options].map((o) => o.textContent)).toEqual([
      "Full review: needs Docker, not running on this computer",
      "Full review and your sign-off: needs Docker, not running on this computer",
    ]);
    expect(level.value).toBe("2");
    expect(within(form).getByTestId("edit-full-review-note")).toHaveTextContent(
      "A deploy keeps the full review and your sign-off: saving moves this task to the full review.",
    );
    await user.click(within(form).getByTestId("save-task"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_deploy")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/task_deploy")[0]?.body).toMatchObject({
      riskTier: 2,
      specialist: "ops-deploy",
    });
    await user.click(within(drawer).getByRole("button", { name: "Close" }));

    // A planner's tier 0 reads as the light review; a new title alone sends the level as stored.
    ({ drawer, form } = await openEdit("task_zero"));
    level = within(form).getByTestId("edit-risk-tier") as HTMLSelectElement;
    expect(level.value).toBe("1");
    expect(level.selectedOptions[0]?.textContent).toBe(
      "Light review: the critic reads the work, nothing runs in isolation",
    );
    expect(within(form).queryByTestId("edit-full-review-note")).toBeNull();
    const title = within(form).getByTestId("edit-title");
    await user.clear(title);
    await user.type(title, "Write the changelog for 2.0");
    await user.click(within(form).getByTestId("save-task"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_zero")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/task_zero")[0]?.body).toMatchObject({
      title: "Write the changelog for 2.0",
      riskTier: 0,
    });
    await user.click(within(drawer).getByRole("button", { name: "Close" }));

    // Handing a light-review task to the deploy specialist: the levels follow, and Save sends
    // the full review the select shows.
    ({ form } = await openEdit("task_zero"));
    await user.selectOptions(within(form).getByTestId("edit-who"), "ops-deploy");
    level = within(form).getByTestId("edit-risk-tier") as HTMLSelectElement;
    expect(level.value).toBe("2");
    expect(within(form).getByTestId("edit-full-review-note")).toBeInTheDocument();
    await user.click(within(form).getByTestId("save-task"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_zero")).toHaveLength(2));
    expect(postedCalls(harness, "/tasks/task_zero")[1]?.body).toMatchObject({
      riskTier: 2,
      specialist: "ops-deploy",
    });
  });

  it("New task offers a deploy no light review and says why; the row of a deploy reads the full review it gets (phase C leftover C-2)", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ sandbox: { state: "not_running" } });
    const coder = harness.daemon.state.modelSettings.specialists[0];
    if (coder)
      harness.daemon.state.modelSettings.specialists.push({ ...coder, name: "ops-deploy" });
    // A deploy stored at the light review by a daemon from before.
    addTask(harness, "task_old_deploy", "Deploy the old site", {
      status: "ready",
      riskTier: 1,
      specialist: "ops-deploy",
    });
    renderApp("/projects/proj_atlas/tasks", harness);
    expect(within(await rowOf("task_old_deploy")).getByText(/Full review ·/)).toBeInTheDocument();
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    const who = within(dialog).getByTestId("task-who") as HTMLSelectElement;
    await waitFor(() => expect([...who.options].map((o) => o.value)).toContain("ops-deploy"));
    await user.selectOptions(who, "ops-deploy");
    const level = within(dialog).getByTestId("task-risk-tier") as HTMLSelectElement;
    expect([...level.options].map((o) => o.textContent)).toEqual([
      "Full review: needs Docker, not running on this computer",
      "Full review and your sign-off: needs Docker, not running on this computer",
    ]);
    expect(level.value).toBe("2");
    expect(within(dialog).getByTestId("task-full-review-note")).toHaveTextContent(
      "A deploy keeps the full review and your sign-off.",
    );
    await user.type(within(dialog).getByTestId("task-title"), "Deploy the site");
    await user.type(within(dialog).getByTestId("task-outcome"), "The site is online");
    await user.click(within(dialog).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/tasks")[0]?.body).toMatchObject({
      title: "Deploy the site",
      riskTier: 2,
      specialist: "ops-deploy",
    });
  });

  it("New task says that Full review needs Docker, offers Who does it, and takes a decimal comma", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ sandbox: { state: "not_running" } });
    renderApp("/projects/proj_atlas/tasks", harness);
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    const level = within(dialog).getByTestId("task-risk-tier") as HTMLSelectElement;
    await waitFor(() =>
      expect([...level.options].map((o) => o.textContent)).toContain(
        "Full review: needs Docker, not running on this computer",
      ),
    );
    expect([...level.options].map((o) => o.textContent).join(" ")).not.toMatch(/tier/);
    const who = within(dialog).getByTestId("task-who") as HTMLSelectElement;
    await waitFor(() =>
      expect([...who.options].map((o) => o.textContent)).toEqual(
        expect.arrayContaining(["Let the agent choose", "Me: ask me in the Inbox"]),
      ),
    );
    await user.type(within(dialog).getByTestId("task-title"), "Confirm the hosting choice");
    await user.type(within(dialog).getByTestId("task-outcome"), "I said where it is hosted");
    await user.selectOptions(level, "Full review: needs Docker, not running on this computer");
    expect(within(dialog).getByTestId("task-docker-note")).toHaveTextContent(
      "Full review needs Docker, which is not running on this computer",
    );
    await user.selectOptions(who, "Me: ask me in the Inbox");
    await user.type(within(dialog).getByTestId("task-budget"), "1,50");
    await user.click(within(dialog).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/tasks")[0]?.body).toMatchObject({
      title: "Confirm the hosting choice",
      riskTier: 2,
      specialist: "person",
      // CHF 1.50 at the project's rate (0.80 CHF per USD).
      budgetUsdMicro: 1_875_000,
      status: "ready",
    });
    // In the list at its place in the run order, with its Undo.
    expect(await screen.findByText("Confirm the hosting choice")).toBeInTheDocument();
    expect(screen.getByTestId("task-moved-sentence")).toHaveTextContent(
      'Added "Confirm the hosting choice" to Atlas, it asks you in the Inbox.',
    );
  });

  it("New task says what a specialist cannot do on this install when it is chosen, in the daemon's words (ADR 0107)", async () => {
    const user = userEvent.setup();
    // An install with no web access (no subscription, the page reader off): the daemon names
    // the researcher's limitation in its specialists list.
    const harness = createHarness({ noWebAccess: true });
    renderApp("/projects/proj_atlas/tasks", harness);
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    const who = within(dialog).getByTestId("task-who") as HTMLSelectElement;
    await waitFor(() =>
      expect([...who.options].map((o) => o.value)).toEqual(
        expect.arrayContaining(["coder", "researcher"]),
      ),
    );
    await user.selectOptions(who, "coder");
    expect(within(dialog).queryByTestId("task-who-note")).toBeNull();
    await user.selectOptions(who, "researcher");
    expect(within(dialog).getByTestId("task-who-note")).toHaveTextContent(
      "Cannot read the web on this computer: the researcher works only from the project's files.",
    );
    // Nothing is refused: the task is created for the researcher as chosen.
    await user.type(within(dialog).getByTestId("task-title"), "Summarise the notes");
    await user.type(within(dialog).getByTestId("task-outcome"), "docs/summary.md exists");
    await user.click(within(dialog).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/tasks")[0]?.body).toMatchObject({
      title: "Summarise the notes",
      specialist: "researcher",
    });
  });

  it("rows follow the work without Refresh: a session's project.changed reloads them (design §3.5)", async () => {
    const harness = createHarness();
    render(
      <AppProvider
        client={harness.client}
        store={harness.store}
        streamOptions={liveEvents(harness)}
      >
        <MemoryRouter initialEntries={["/projects/proj_atlas/tasks"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent("Ready");
    // A session took the task (the daemon says the project changed).
    const task = harness.daemon.state.tasks.find((t) => t.id === "task_3");
    if (!task) throw new Error("no task_3");
    task.status = "in_progress";
    task.claimedBy = "agent_alice";
    task.version += 1;
    for (const l of harness.daemon.state.listeners) l("project.changed", { id: "proj_atlas" });
    await waitFor(async () =>
      expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent("Running"),
    );
    task.status = "done";
    task.claimedBy = null;
    task.version += 1;
    for (const l of harness.daemon.state.listeners) l("project.changed", { id: "proj_atlas" });
    await waitFor(async () =>
      expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent("Done"),
    );
  });

  it("the filters live in the address and survive switching tabs", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/tasks?status=done");
    await waitFor(() => expect(screen.getAllByTestId("task-row")).toHaveLength(1));
    expect((screen.getByTestId("filter-status") as HTMLSelectElement).value).toBe("done");
    await user.type(screen.getByTestId("filter-text"), "index");
    expect(screen.getAllByTestId("task-row")).toHaveLength(1);
    // Away to another tab and back through the tab links, which carry no query.
    await user.click(screen.getByTestId("tab-summary"));
    await screen.findByTestId("tab-panel-summary");
    await user.click(screen.getByTestId("tab-tasks"));
    await waitFor(() =>
      expect((screen.getByTestId("filter-status") as HTMLSelectElement).value).toBe("done"),
    );
    expect((screen.getByTestId("filter-text") as HTMLInputElement).value).toBe("index");
    expect(screen.getAllByTestId("task-row")).toHaveLength(1);
    // Cleared, they stay cleared on the next return.
    await user.selectOptions(screen.getByTestId("filter-status"), "");
    await user.clear(screen.getByTestId("filter-text"));
    await user.click(screen.getByTestId("tab-summary"));
    await screen.findByTestId("tab-panel-summary");
    await user.click(screen.getByTestId("tab-tasks"));
    await waitFor(() => expect(screen.getAllByTestId("task-row").length).toBeGreaterThan(1));
    expect((screen.getByTestId("filter-status") as HTMLSelectElement).value).toBe("");
  });

  it("Change what it waits for: picked by title in plain words, sent through the command, with Undo", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_failed", "Fail by error", { status: "failed" });
    renderApp("/projects/proj_atlas/tasks", harness);
    await user.click(within(await rowOf("task_3")).getByTestId("task-title"));
    const drawer = await screen.findByTestId("task-drawer");
    await user.click(await within(drawer).findByTestId("drawer-action-dependencies"));
    const dialog = await screen.findByTestId("dependencies-dialog");
    const labels = within(dialog)
      .getAllByTestId("dependency-option")
      .map((o) => o.closest("label")?.textContent);
    // In run order, each with its state in words.
    expect(labels).toEqual([
      "Fail by error (failed)",
      "Index the documentation pages (done)",
      "Add the search box to the header (not done yet: Being reviewed)",
    ]);
    // Ticking a failed task says what that means.
    await user.click(within(dialog).getByLabelText(/Fail by error/));
    expect(within(dialog).getByTestId("dependency-failed")).toHaveTextContent(
      '"Fail by error" failed: this task waits until it is tried again and done.',
    );
    await user.click(within(dialog).getByLabelText(/Fail by error/));
    await user.click(within(dialog).getByLabelText(/Add the search box to the header/));
    await user.click(within(dialog).getByTestId("save-dependencies"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_3/dependencies")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/task_3/dependencies")[0]?.body).toEqual({
      version: 1,
      dependsOn: ["task_2"],
    });
    await waitFor(() =>
      expect(screen.getByTestId("task-moved-sentence")).toHaveTextContent(
        '"Decide the versioning scheme" now waits for "Add the search box to the header".',
      ),
    );
    expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent(
      'Waiting for "Add the search box to the header"',
    );
  });

  it("a done task offers no dependency change; the daemon's refusal of a cycle stays in the dialog", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_after", "Write the migration guide", { dependsOn: ["task_3"] });
    renderApp("/projects/proj_atlas/tasks", harness);
    await user.click(within(await rowOf("task_1")).getByTestId("task-title"));
    // A done task's dependencies no longer matter: Redo only.
    let drawer = await screen.findByTestId("task-drawer");
    expect(await within(drawer).findByTestId("drawer-actions")).not.toHaveTextContent(
      "Change what it waits for",
    );
    await user.click(within(drawer).getByRole("button", { name: "Close" }));
    // The other way round would make the two wait on each other: refused, the dialog says why.
    await user.click(within(await rowOf("task_3")).getByTestId("task-title"));
    drawer = await screen.findByTestId("task-drawer");
    await user.click(await within(drawer).findByTestId("drawer-action-dependencies"));
    const dialog = await screen.findByTestId("dependencies-dialog");
    await user.click(within(dialog).getByLabelText(/Write the migration guide/));
    await user.click(within(dialog).getByTestId("save-dependencies"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      'Depends on: "Write the migration guide" already waits on "Decide the versioning scheme"',
    );
    expect(within(await rowOf("task_3")).getByTestId("task-status")).toHaveTextContent("Ready");
  });

  it("New task picks what it waits for by title and sends the ids (U-040)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    await user.type(within(dialog).getByTestId("task-title"), "Announce the search");
    await user.type(within(dialog).getByTestId("task-outcome"), "A post announces it");
    expect(within(dialog).queryByRole("textbox", { name: /Waits for/ })).toBeNull();
    await user.click(await within(dialog).findByLabelText(/Add the search box to the header/));
    await user.click(within(dialog).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/tasks")[0]?.body).toMatchObject({
      title: "Announce the search",
      dependsOn: ["task_2"],
    });
  });

  it("New task sets Low, Medium or High and the Tasks tab shows the level, never a number (U-041)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    expect(await rowOf("task_1")).toHaveTextContent("Low priority");
    expect(await rowOf("task_3")).toHaveTextContent("Medium priority");
    expect(await rowOf("task_3")).not.toHaveTextContent(/priority \d/);
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    const select = within(dialog).getByLabelText(/^Priority/) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Low", "Medium", "High"]);
    expect(select.value).toBe("medium");
    expect(within(dialog).getByText("High runs first.")).toBeInTheDocument();
    await user.type(within(dialog).getByTestId("task-title"), "Patch the security hole");
    await user.type(within(dialog).getByTestId("task-outcome"), "The hole is closed");
    await user.selectOptions(select, "High");
    await user.click(within(dialog).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/tasks")[0]?.body).toMatchObject({
      title: "Patch the security hole",
      priority: "high",
    });
    const created = (await screen.findAllByTestId("task-row")).find((r) =>
      r.textContent?.includes("Patch the security hole"),
    );
    expect(created).toHaveTextContent("High priority");
  });

  it("creates a task with the budget converted at the project's rate; it shows that budget as what stops it (U-042)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    await screen.findAllByTestId("task-row");
    // A budget of USD 6 (CHF 4.80) and an estimate of USD 4 (CHF 3.20): the budget stops it.
    const withBudget = within(await rowOf("task_2")).getByTestId("task-cap");
    expect(withBudget).toHaveTextContent("of CHF 4.80 budget");
    expect(withBudget).not.toHaveTextContent("CHF 3.20");
    // No budget: each run stops at the researcher's limit per run (USD 2.50, CHF 2.00).
    expect(within(await rowOf("task_3")).getByTestId("task-cap")).toHaveTextContent(
      "each run stops at CHF 2.00 (researcher limit)",
    );
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    await user.type(within(dialog).getByTestId("task-title"), "Write the deploy runbook");
    await user.type(
      within(dialog).getByTestId("task-outcome"),
      "docs/runbook.md explains the deploy",
    );
    await user.type(within(dialog).getByTestId("task-criteria"), "Covers rollback\nCovers secrets");
    await user.type(within(dialog).getByTestId("task-budget"), "4");
    await user.click(within(dialog).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/tasks")[0]?.body).toEqual({
      title: "Write the deploy runbook",
      outcome: "docs/runbook.md explains the deploy",
      acceptanceCriteria: ["Covers rollback", "Covers secrets"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 5_000_000,
    });
    const title = await screen.findByText("Write the deploy runbook");
    const row = title.closest("[data-testid=task-row]") as HTMLElement;
    expect(within(row).getByTestId("task-cap")).toHaveTextContent("of CHF 4.00 budget");
  });

  it("a done task says how it was checked, and its drawer opens the evidence: the checks, the page tried and its screenshot (ADR 0104)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const tried = {
      checks: [
        {
          name: "test",
          passed: true,
          output: "npm run --silent test -> exit 0 in 812 ms\n4 passing",
        },
      ],
      tried: [
        {
          what: "opened index.html in a browser, 1280 and 390 pixels wide",
          target: "index.html",
          ok: true,
          output:
            "opened index.html at 1280 and 390 pixels wide, the network off\ntitle: Atlas docs\ntext seen: Search the docs",
          screenshots: [{ label: "1280 pixels wide (a computer)", file: "run_1/index-1280.png" }],
        },
      ],
      notChecked: [
        "about.html was not tried: no Chromium, Edge or Chrome was found on this computer",
      ],
    };
    harness.daemon.state.evidenceFiles.set("task_1/run_1/index-1280.png", "iVBORw0KGgo=");
    renderApp("/projects/proj_atlas/tasks", harness);
    // Reviewed without a try: the row and the drawer say "Reviewed".
    const row = await rowOf("task_1");
    expect(within(row).getByTestId("task-status")).toHaveTextContent("Done");
    expect(await within(row).findByTestId("task-check")).toHaveTextContent(/^Reviewed$/);
    expect(row).not.toHaveTextContent(/checks only|tier/i);
    await user.click(within(row).getByTestId("task-title"));
    const drawer = await screen.findByTestId("task-drawer");
    expect(await within(drawer).findByTestId("drawer-check")).toHaveTextContent(
      "Reviewed The critic read the work against each point above.",
    );
    await user.click(within(drawer).getByRole("button", { name: "Close" }));

    // Reviewed and tried: the row says so, and the drawer opens what was run and tried.
    harness.daemon.state.reviewEvidence.set("task_1", tried);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(async () =>
      expect(within(await rowOf("task_1")).getByTestId("task-check")).toHaveTextContent(
        "Reviewed and tried",
      ),
    );
    await user.click(within(await rowOf("task_1")).getByTestId("task-title"));
    const again = await screen.findByTestId("task-drawer");
    expect(await within(again).findByTestId("drawer-check")).toHaveTextContent(
      "Reviewed and tried",
    );
    // One click away: the evidence, closed until asked for; the screenshot is read when opened.
    const evidence = within(again).getByTestId("review-evidence");
    expect(within(evidence).queryByTestId("evidence-screenshot")).not.toBeInTheDocument();
    await user.click(within(evidence).getByText("See what was checked"));
    expect(within(evidence).getByTestId("evidence-checks")).toHaveTextContent("test: passed");
    expect(within(evidence).getByTestId("evidence-checks")).toHaveTextContent("4 passing");
    expect(within(evidence).getByTestId("evidence-tried")).toHaveTextContent("index.html: worked");
    expect(within(evidence).getByTestId("evidence-tried")).toHaveTextContent(
      "text seen: Search the docs",
    );
    expect(within(evidence).getByTestId("evidence-not-checked")).toHaveTextContent(
      "about.html was not tried: no Chromium",
    );
    const shot = await within(evidence).findByTestId("evidence-screenshot");
    expect(shot.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(shot.getAttribute("alt")).toBe("The page, 1280 pixels wide (a computer)");
  });

  it("New task offers no Checks only (ADR 0104): the light review is the least a task gets", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    const level = within(dialog).getByTestId("task-risk-tier") as HTMLSelectElement;
    const labels = [...level.options].map((o) => o.textContent ?? "");
    expect(labels.join(" / ")).not.toMatch(/checks only|automatic checks|tier/i);
    expect(labels).toContain("Light review: the critic reads the work, nothing runs in isolation");
    expect([...level.options].map((o) => o.value)).not.toContain("0");
  });

  it("the fake daemon words a sandbox that is not running as the daemon does", () => {
    expect(fakeSandboxView("not_running").ready).toBe(false);
  });
});
