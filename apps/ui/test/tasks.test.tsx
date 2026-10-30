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
        .getAllByRole("button")
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
      priority: 5,
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 5_000_000,
    });
    await waitFor(() => expect(screen.getAllByTestId("task-row")).toHaveLength(4));
  });
});
