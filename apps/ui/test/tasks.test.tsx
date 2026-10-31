import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  AGENT_ONLY_STATUSES as UI_AGENT_ONLY,
  TASK_TRANSITIONS as UI_TRANSITIONS,
} from "../src/lib/task-transitions.ts";
import { filterTasks, latestRunByTask } from "../src/pages/project/TasksTab.tsx";
import { RUNS, TASKS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

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

describe("Tasks tab", () => {
  it("filters tasks and finds the latest run per task", () => {
    expect(
      filterTasks(TASKS, { status: "done", specialist: "", text: "" }).map((t) => t.id),
    ).toEqual(["task_1"]);
    expect(
      filterTasks(TASKS, { status: "", specialist: "researcher", text: "" }).map((t) => t.id),
    ).toEqual(["task_3"]);
    expect(
      filterTasks(TASKS, { status: "", specialist: "", text: "search BOX" }).map((t) => t.id),
    ).toEqual(["task_2"]);
    const latest = latestRunByTask(RUNS);
    expect(latest.get("task_2")?.verdict).toBe("revise");
  });

  it("lists tasks with status, specialist, cost, verdict and links; filters by status", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/tasks");
    const rows = await screen.findAllByTestId("task-row");
    expect(rows).toHaveLength(3);
    const second = within(rows[1] as HTMLElement);
    expect(second.getByText("Add the search box to the header")).toBeInTheDocument();
    expect(second.getByText("in_review")).toBeInTheDocument();
    expect(second.getByText("coder")).toBeInTheDocument();
    expect(second.getByText("CHF 3.60")).toBeInTheDocument();
    expect(second.getByText("revise")).toBeInTheDocument();
    expect(second.getByTestId("pr-link")).toHaveAttribute(
      "href",
      "https://example.test/org/atlas/pull/12",
    );
    expect(second.getByTestId("review-link")).toHaveAttribute(
      "href",
      "/projects/proj_atlas/reviews?review=rev_2",
    );
    await user.selectOptions(screen.getByTestId("filter-status"), "ready");
    await waitFor(() => expect(screen.getAllByTestId("task-row")).toHaveLength(1));
    expect(screen.getAllByTestId("task-row")[0]).toHaveAttribute("data-task-id", "task_3");
  });

  it("offers only legal transitions and posts the move with version and reason", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    const rows = await screen.findAllByTestId("task-row");
    const done = rows[0] as HTMLElement;
    expect(within(done).queryAllByRole("button")).toHaveLength(0);
    const ready = rows[2] as HTMLElement;
    expect(
      within(ready)
        .getAllByTestId(/^transition-/)
        .map((b) => b.textContent),
    ).toEqual(["Needs me", "Mark failed", "Cancel"]);
    // U-013: Claim is an agent's lock; a person's left the task held by nobody.
    expect(within(ready).queryByTestId("transition-claimed")).toBeNull();
    await user.click(within(ready).getByTestId("transition-needs_human"));
    const dialog = await screen.findByTestId("transition-dialog");
    await user.type(within(dialog).getByTestId("transition-reason"), "I need to decide this");
    await user.click(within(dialog).getByTestId("confirm-transition"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_3/transition")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/task_3/transition")[0]?.body).toEqual({
      version: 1,
      to: "needs_human",
      reason: "I need to decide this",
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("task-row")[2]).toHaveAttribute("data-status", "needs_human"),
    );
  });

  it("moves a task without a reason, sending what changed as the reason (U-010)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    const rows = await screen.findAllByTestId("task-row");
    await user.click(within(rows[2] as HTMLElement).getByTestId("transition-cancelled"));
    const dialog = await screen.findByTestId("transition-dialog");
    expect(within(dialog).getByText(/Left empty: "Cancelled in the app"/)).toBeInTheDocument();
    expect(within(dialog).getByTestId("confirm-transition")).toBeEnabled();
    await user.click(within(dialog).getByTestId("confirm-transition"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_3/transition")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/task_3/transition")[0]?.body).toEqual({
      version: 1,
      to: "cancelled",
      reason: "Cancelled in the app",
    });
  });

  it("Cancel on a running task says its run stops and the session goes on, and sends the move (U-039)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.tasks.push({
      ...(TASKS[2] as (typeof TASKS)[number]),
      id: "task_running",
      title: "Migrate the search index",
      status: "in_progress",
      claimedBy: "agent_alice",
      version: 3,
    });
    renderApp("/projects/proj_atlas/tasks", harness);
    const row = (await screen.findAllByTestId("task-row")).find(
      (r) => r.getAttribute("data-task-id") === "task_running",
    ) as HTMLElement;
    expect(
      within(row)
        .getAllByTestId(/^transition-/)
        .map((b) => b.textContent),
    ).toEqual(["Send to review", "Needs me", "Mark failed", "Cancel"]);
    await user.click(within(row).getByTestId("transition-cancelled"));
    const dialog = await screen.findByTestId("transition-dialog");
    expect(within(dialog).getByTestId("transition-stops-run")).toHaveTextContent(
      "A session is working on this task. Its run stops now; the session goes on with its other tasks and leaves this one cancelled.",
    );
    await user.click(within(dialog).getByTestId("confirm-transition"));
    await waitFor(() =>
      expect(postedCalls(harness, "/tasks/task_running/transition")).toHaveLength(1),
    );
    expect(postedCalls(harness, "/tasks/task_running/transition")[0]?.body).toEqual({
      version: 3,
      to: "cancelled",
      reason: "Cancelled in the app",
    });
    // A task no session is working on gets no such note.
    await user.click(
      within((await screen.findAllByTestId("task-row"))[2] as HTMLElement).getByTestId(
        "transition-failed",
      ),
    );
    expect(
      within(await screen.findByTestId("transition-dialog")).queryByTestId("transition-stops-run"),
    ).toBeNull();
  });

  it("shows what a task waits on by title, and a ready task stuck behind a cancelled one (U-040)", async () => {
    const harness = createHarness();
    harness.daemon.state.tasks.push(
      {
        ...(TASKS[2] as (typeof TASKS)[number]),
        id: "task_old",
        title: "Try the old approach",
        status: "cancelled",
      },
      {
        ...(TASKS[2] as (typeof TASKS)[number]),
        id: "task_blocked",
        title: "Write the migration guide",
        dependsOn: ["task_old"],
      },
    );
    renderApp("/projects/proj_atlas/tasks", harness);
    const rows = await screen.findAllByTestId("task-row");
    const rowOf = (id: string) =>
      rows.find((r) => r.getAttribute("data-task-id") === id) as HTMLElement;
    expect(rowOf("task_2")).toHaveTextContent('after "Index the documentation pages"');
    expect(rowOf("task_2")).not.toHaveTextContent("task_1 ");
    expect(rowOf("task_blocked")).toHaveTextContent('after "Try the old approach" (cancelled)');
    expect(within(rowOf("task_blocked")).getByTestId("stuck-dependency")).toHaveTextContent(
      "no session runs this one until you change what it depends on",
    );
    expect(within(rowOf("task_3")).queryByTestId("stuck-dependency")).toBeNull();
  });

  it("changes what a task depends on by title, and shows the daemon's refusal of a cycle (U-040)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    const rowOf = async (id: string) =>
      (await screen.findAllByTestId("task-row")).find(
        (r) => r.getAttribute("data-task-id") === id,
      ) as HTMLElement;
    // A done task's dependencies no longer matter: no control.
    expect(within(await rowOf("task_1")).queryByTestId("edit-dependencies")).toBeNull();
    await user.click(within(await rowOf("task_3")).getByTestId("edit-dependencies"));
    let dialog = await screen.findByTestId("dependencies-dialog");
    // Titles, not ids; the task itself is not offered.
    const options = within(dialog).getAllByTestId("dependency-option");
    expect(options.map((o) => o.closest("label")?.textContent)).toEqual([
      "Index the documentation pages (done)",
      "Add the search box to the header (in_review)",
    ]);
    await user.click(within(dialog).getByLabelText(/Add the search box to the header/));
    await user.click(within(dialog).getByTestId("save-dependencies"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_3/dependencies")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/task_3/dependencies")[0]?.body).toEqual({
      version: 1,
      dependsOn: ["task_2"],
      reason: "Dependencies changed in the app",
    });
    await waitFor(async () =>
      expect(await rowOf("task_3")).toHaveTextContent(
        'after "Add the search box to the header" (in_review)',
      ),
    );
    // The other way round would make the two wait on each other: refused, the dialog says why.
    await user.click(within(await rowOf("task_2")).getByTestId("edit-dependencies"));
    dialog = await screen.findByTestId("dependencies-dialog");
    await user.click(within(dialog).getByLabelText(/Decide the versioning scheme/));
    await user.click(within(dialog).getByTestId("save-dependencies"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      'Depends on: "Decide the versioning scheme" already waits on "Add the search box to the header"',
    );
    expect(await rowOf("task_2")).toHaveTextContent('after "Index the documentation pages"');
  });

  it("New task picks what it depends on by title and sends the ids (U-040)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    await user.type(within(dialog).getByTestId("task-title"), "Announce the search");
    await user.type(within(dialog).getByTestId("task-outcome"), "A post announces it");
    // No free-text ids any more: the project's tasks by title.
    expect(within(dialog).queryByRole("textbox", { name: /Depends on/ })).toBeNull();
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
    const rows = await screen.findAllByTestId("task-row");
    // The fixtures' levels as the daemon answers them.
    expect(rows[0]).toHaveTextContent("Low priority");
    expect(rows[2]).toHaveTextContent("Medium priority");
    expect(rows[2]).not.toHaveTextContent(/priority \d/);
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    const select = within(dialog).getByLabelText(/^Priority/) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Low", "Medium", "High"]);
    expect(select.value).toBe("medium");
    expect(within(dialog).getByText("High runs first.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/1 high/)).toBeNull();
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

  it("creates a task from the dialog with the budget converted at the project's rate", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    await user.type(within(dialog).getByTestId("task-title"), "Write the deploy runbook");
    await user.type(
      within(dialog).getByTestId("task-outcome"),
      "docs/runbook.md explains the deploy",
    );
    await user.type(
      within(dialog).getByLabelText(/Acceptance criteria/),
      "Covers rollback\nCovers secrets",
    );
    await user.type(within(dialog).getByLabelText(/Budget/), "4");
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
    await waitFor(() => expect(screen.getAllByTestId("task-row")).toHaveLength(4));
  });
});
