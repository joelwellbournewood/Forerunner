import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * w15-chat (wave 15): the screens of this area as the person clicks them, against the fake
 * daemon (which mirrors the daemon's words; the routes are in real-daemon.test.ts,
 * "w15-chat, wave 15").
 */
describe("w15-chat, wave 15", () => {
  // W15-34: Changes showed the undo's change card (risk, scope, "no undo", "This cannot be
  // undone.") under "Undoing this puts a value back …"; now the one question the Inbox shows.
  it("Changes: an undo that waits for a yes shows its one question with Yes and No, no card rows (W15-34)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const lowered = await harness.client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 100 } }],
      source: "ui",
      confirm: "tap",
    });
    renderApp("/changes", harness);
    const row = (await screen.findAllByTestId("change")).find(
      (r) => r.dataset.changeId === lowered.changeLogId,
    ) as HTMLElement;
    await user.click(within(row).getByTestId("change-undo"));
    await waitFor(() =>
      expect(postedCalls(harness, `/changes/${lowered.changeLogId}/undo`)).toHaveLength(1),
    );
    const asking = await screen.findByTestId("changes-undo-pending");
    expect(within(asking).getByTestId("command-readback")).toHaveTextContent(
      /^Take back "Lowered the monthly hard ceiling from CHF 150(\.00)? to CHF 100(\.00)?"\? Confirm in the app on a paired device\.$/,
    );
    expect(within(asking).queryByTestId("card-old")).not.toBeInTheDocument();
    expect(within(asking).queryByTestId("card-undo")).not.toBeInTheDocument();
    expect(asking).not.toHaveTextContent(/undo:|cannot be undone|Risk: |Scope: /);
    expect(within(asking).getByTestId("command-yes")).toBeInTheDocument();
    expect(within(asking).getByTestId("command-no")).toBeInTheDocument();
  });

  // W15-36: one click on Create project wrote two things: the creation, then a project.switch
  // ("Switched the active project to …"), whose row was the one Changes offered to undo.
  it("New project makes the new project active in one command: one Changes row, no project.switch (W15-36)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const before = harness.daemon.state.changes.length;
    renderApp("/", harness);
    await screen.findAllByTestId("project-card");
    await user.click(screen.getByTestId("new-project"));
    const dialog = await screen.findByTestId("new-project-dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Garden club");
    await user.type(within(dialog).getByLabelText(/Goal/), "A page for the club");
    await user.click(within(dialog).getByTestId("create-project"));
    await waitFor(() => expect(postedCalls(harness, "/projects")).toHaveLength(1));
    expect(postedCalls(harness, "/projects")[0]?.body).toEqual({
      name: "Garden club",
      goal: "A page for the club",
      switch: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId("active-project")).toHaveTextContent("Garden club"),
    );
    // No second command: the switch is the creation's.
    expect(
      postedCalls(harness, "/commands/execute").filter((c) =>
        JSON.stringify(c.body).includes("project.switch"),
      ),
    ).toEqual([]);
    expect(harness.daemon.state.changes.length - before).toBe(1);
    expect(harness.daemon.state.changes[0]?.sentence).toBe(
      "Created the project Garden club and made it the active project. Undo.",
    );
  });
});
