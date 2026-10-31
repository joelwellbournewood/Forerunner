import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ME } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Undo asks for the confirmation the restored value needs (U-057): undoing a lowered monthly
 * cap is a raise, so Changes shows its card and this PC confirms it, as raising it would.
 */
describe("undo asks for the confirmation of the value it restores (U-057)", () => {
  it("Changes: undoing a lowered monthly cap shows the card; this PC confirms; the cap is back", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    // Lowered from CHF 150 to CHF 100 in Settings (medium: a tap confirmed it).
    const lowered = await harness.client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 100 } }],
      source: "ui",
      confirm: "tap",
    });
    expect(lowered.status).toBe("done");
    expect(harness.daemon.state.changes[0]?.sentence).toBe(
      "Lowered the monthly hard ceiling from CHF 150 to CHF 100. Undo.",
    );
    renderApp("/changes", harness);
    const row = (await screen.findAllByTestId("change")).find(
      (r) => r.dataset.changeId === lowered.changeLogId,
    ) as HTMLElement;
    await user.click(within(row).getByTestId("change-undo"));
    await waitFor(() =>
      expect(postedCalls(harness, `/changes/${lowered.changeLogId}/undo`)).toHaveLength(1),
    );
    const asking = await screen.findByTestId("changes-undo-pending");
    expect(within(asking).getByTestId("command-pending")).toHaveAttribute(
      "data-decision",
      "needs_device",
    );
    expect(within(asking).getByTestId("needs-device")).toHaveTextContent("paired device");
    // Nothing changed yet, and nothing says "Undone".
    expect(screen.queryByTestId("changes-note")).not.toBeInTheDocument();
    expect((await harness.client.me()).monthlyCap.chfMicro).toBe(100_000_000);
    await user.click(within(asking).getByTestId("command-yes"));
    // The device answer names this PC's own row, as `/me` names it (ADR 0030).
    await waitFor(() =>
      expect(
        harness.daemon.state.calls.find((c) => /^\/commands\/[^/]+\/confirm$/.test(c.path))?.body,
      ).toEqual({ answer: "device", deviceId: ME.desktopDeviceId }),
    );
    expect(await screen.findByTestId("changes-note")).toHaveTextContent(
      "Undone: Lowered the monthly hard ceiling from CHF 150 to CHF 100.",
    );
    expect(screen.queryByTestId("changes-undo-pending")).not.toBeInTheDocument();
    const me = await harness.client.me();
    expect(me.monthlyCap.chfMicro).toBe(150_000_000);
  });

  it("No leaves the cap as it is and says so", async () => {
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
    const asking = await screen.findByTestId("changes-undo-pending");
    await user.click(within(asking).getByTestId("command-no"));
    expect(await screen.findByTestId("changes-note")).toHaveTextContent(
      "Undo cancelled. Nothing changed.",
    );
    expect((await harness.client.me()).monthlyCap.chfMicro).toBe(100_000_000);
  });
});
