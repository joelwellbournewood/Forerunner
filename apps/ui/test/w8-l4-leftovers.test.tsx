import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { money, TASKS } from "./fixtures.ts";
import { createHarness, renderApp } from "./helpers.tsx";

/**
 * w8-l4-leftovers, wave 8: run L4's leftovers on starts, sessions and money, at the boundary the
 * person uses (the screens over the fake daemon, which follows the real one).
 */
describe("w8-l4-leftovers, wave 8: a task that spent nothing shows no CHF 0.00 (L4i-left-64)", () => {
  it("the Tasks tab's row of a ready task that spent nothing has no money; a task that spent shows it", async () => {
    // L4d-left-9 (design section 5 rule 5, no zero counts): before, every row read "CHF 0.00".
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    const rows = await screen.findAllByTestId("task-row");
    const row = (title: string) => {
      const found = rows.find((r) => r.textContent?.includes(title));
      if (!found) throw new Error(`no row for ${title}`);
      return found;
    };
    await waitFor(() => expect(row("Decide the versioning scheme")).toBeInTheDocument());
    expect(row("Decide the versioning scheme").textContent).not.toContain("CHF 0.00");
    expect(within(row("Index the documentation pages")).getByText(/^CHF \d+\.\d\d$/)).toBeTruthy();
  });
});

/**
 * fixup-w8-l4-leftovers, wave 8 (the review's blocking item 3, a regression of L4i-left-64): with
 * no amount before it, a budgeted task that spent nothing read the fragment "of CHF 0.01 budget"
 * in its Cost cell (before L4i-left-64: "CHF 0.00 of CHF 0.01 budget"), and its drawer read
 * "spent CHF 0.00" (the sibling, validation rule 8).
 */
describe("w8-l4-leftovers, wave 8: a budgeted task that spent nothing reads its budget alone (L4i-left-64)", () => {
  it("the row says 'CHF 0.01 budget', the drawer names the budget without 'spent CHF 0.00'; a task that spent keeps 'of'", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.tasks.push({
      ...(TASKS[2] as (typeof TASKS)[number]),
      id: "t_pond",
      title: "Write the pond notes",
      status: "ready",
      riskTier: 1,
      prUrl: null,
      specialist: "coder",
      budget: money(12_500),
      actual: money(0),
      spent: money(0),
      cap: money(12_500),
      capSource: "task_budget",
    });
    harness.daemon.state.tasks.push({
      ...(TASKS[2] as (typeof TASKS)[number]),
      id: "t_frog",
      title: "Write the frog notes",
      status: "in_progress",
      riskTier: 1,
      prUrl: null,
      specialist: "coder",
      budget: money(250_000),
      actual: money(75_000),
      spent: money(75_000),
      cap: money(175_000),
      capSource: "task_budget",
    });
    renderApp("/projects/proj_atlas/tasks", harness);
    const rowOf = async (id: string) =>
      (await screen.findAllByTestId("task-row")).find(
        (r) => r.getAttribute("data-task-id") === id,
      ) as HTMLElement;
    const pond = await rowOf("t_pond");
    expect(within(pond).getByTestId("task-cap").textContent).toBe("CHF 0.01 budget");
    expect(pond.textContent).not.toContain("CHF 0.00");
    expect(pond.textContent).not.toMatch(/of CHF/);
    // A task that spent keeps its amount and "of" its budget (BA-9).
    expect(within(await rowOf("t_frog")).getByTestId("task-cap").textContent).toBe(
      "of CHF 0.20 budget",
    );
    // The drawer: what it may spend, never "spent CHF 0.00".
    await user.click(within(pond).getByTestId("task-title"));
    const drawer = await screen.findByTestId("task-drawer");
    const body = within(drawer).getByTestId("task-drawer-body");
    expect(body.textContent).not.toContain("CHF 0.00");
    expect(body.textContent).toContain("budget CHF 0.01");
  });
});
