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
});
