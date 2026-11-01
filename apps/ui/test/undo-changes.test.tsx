import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Undo and the change log (U-061): a task move in the Tasks tab is in Changes, as its dialog
 * says, with Undo (a cancel reopens the task); Undo is offered only where it works, and an
 * undo that cannot work says why instead of "Undone".
 */
describe("undo and the change log (U-061)", () => {
  it("cancelling in the Tasks tab is logged with its reason and undone by reopening", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    const rows = await screen.findAllByTestId("task-row");
    const row = rows.find((r) => r.dataset.taskId === "task_3") as HTMLElement;
    await user.click(within(row).getByTestId("action-cancel"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(dialog).toHaveTextContent("Goes into the task's next brief.");
    await user.type(within(dialog).getByTestId("action-note"), "not needed any more");
    await user.click(within(dialog).getByTestId("confirm-action"));
    const moved = await screen.findByTestId("task-moved");
    // One plain line (design §3.5); its Undo is the button beside it.
    expect(within(moved).getByTestId("task-moved-sentence")).toHaveTextContent(
      'Cancelled "Decide the versioning scheme". Its card in the Inbox was withdrawn. Your note goes into its brief if you reopen it.',
    );
    // In the change log: the Tasks tab's own source and the words given.
    expect(harness.daemon.state.changes[0]).toMatchObject({
      source: "ui",
      wordsUsed: "not needed any more",
      commands: [{ name: "task.transition", params: { task: "task_3" } }],
      undoable: true,
    });
    await user.click(within(moved).getByTestId("task-moved-undo"));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("task-moved")).getByTestId("task-moved-sentence"),
      ).toHaveTextContent(
        'Undone: reopened the task "Decide the versioning scheme"; it is ready again and its card is back in the Inbox.',
      ),
    );
    // The card the cancel withdrew is open again.
    const cards = harness.daemon.state.requests.filter((r) => r.taskId === "task_3");
    expect(cards.map((r) => r.status)).toContain("open");
    expect(cards.map((r) => r.status)).not.toContain("withdrawn");
    await waitFor(() =>
      expect(
        screen.getAllByTestId("task-row").find((r) => r.dataset.taskId === "task_3"),
      ).toHaveAttribute("data-status", "ready"),
    );
    expect(screen.queryByTestId("task-moved-undo")).not.toBeInTheDocument();
  });

  it("Changes offers no Undo where it cannot work and says why", async () => {
    const harness = createHarness();
    // "add a task" in chat, and the task was finished since.
    await harness.client.chat({
      humanId: "human_alice",
      agentId: "agent_alice",
      projectId: "proj_atlas",
      text: "add a task: tidy the changelog",
    });
    const created = harness.daemon.state.changes[0];
    const task = harness.daemon.state.tasks.find((t) => t.title === "tidy the changelog");
    if (task) task.status = "done";
    renderApp("/changes", harness);
    const row = (await screen.findAllByTestId("change")).find(
      (r) => r.dataset.changeId === created?.id,
    ) as HTMLElement;
    expect(within(row).queryByTestId("change-undo")).not.toBeInTheDocument();
    expect(within(row).getByTestId("change-undo-blocked")).toHaveTextContent(
      'Cannot be undone now: the task "tidy the changelog" is done; a done task cannot be cancelled, so its creation cannot be undone.',
    );
  });

  it("an undo refused by the daemon says so in words and never 'Undone'", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    await harness.client.chat({
      humanId: "human_alice",
      agentId: "agent_alice",
      projectId: "proj_atlas",
      text: "add a task: tidy the changelog",
    });
    const created = harness.daemon.state.changes[0];
    renderApp("/changes", harness);
    const row = (await screen.findAllByTestId("change")).find(
      (r) => r.dataset.changeId === created?.id,
    ) as HTMLElement;
    // Finished in the meantime, after the page was loaded.
    const task = harness.daemon.state.tasks.find((t) => t.title === "tidy the changelog");
    if (task) task.status = "done";
    await user.click(within(row).getByTestId("change-undo"));
    expect(await screen.findByTestId("changes-error")).toHaveTextContent(
      'Not undone: the task "tidy the changelog" is done',
    );
    expect(screen.queryByTestId("changes-note")).not.toBeInTheDocument();
    expect(postedCalls(harness, `/changes/${created?.id}/undo`)).toHaveLength(1);
  });

  it("an undo made from Changes is logged with the Changes screen's source, not chat", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    await harness.client.chat({
      humanId: "human_alice",
      agentId: "agent_alice",
      projectId: "proj_atlas",
      text: "add a task: tidy the changelog",
    });
    const created = harness.daemon.state.changes[0];
    renderApp("/changes", harness);
    const row = (await screen.findAllByTestId("change")).find(
      (r) => r.dataset.changeId === created?.id,
    ) as HTMLElement;
    await user.click(within(row).getByTestId("change-undo"));
    expect(await screen.findByTestId("changes-note")).toHaveTextContent(
      'Undone: cancelled the task "tidy the changelog" you created.',
    );
    expect(harness.daemon.state.changes[0]).toMatchObject({
      source: "ui",
      commands: [{ name: "undo", params: { of: created?.id } }],
    });
  });
});
