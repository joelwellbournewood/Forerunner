import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { commandForSetting, FAST_MODE_KEY, fastModeRows } from "../src/pages/SettingsPage.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Opus fast mode per project on the Settings page (spec D.20, ADR 0057): a card that says what
 * the flag does and what it costs, both ways, in the daemon's words; each project's state; and
 * a toggle that runs `settings.set` through the same change card chat and voice get, with the
 * effect and the surcharge of the direction asked.
 */
const ON =
  "Opus runs of this project on an API key are requested in fast mode at USD 8 / 40 per million input / output tokens instead of USD 4 / 20, a 2x surcharge; a subscription ignores it (API only)";
const OFF =
  "Opus runs of this project go back to the standard speed at USD 4 / 20 per million input / output tokens; the fast-mode surcharge (2x, USD 8 / 40) stops";

function fastHarness() {
  const harness = createHarness();
  harness.daemon.state.fastMode = { proj_atlas: false, proj_beacon: true };
  return harness;
}

describe("Settings: Opus fast mode (D.20)", () => {
  it("the card explains the effect and the surcharge both ways and lists each project's state", async () => {
    renderApp("/settings", fastHarness());
    const card = await screen.findByTestId("fast-mode-card");
    expect(card).toHaveTextContent("Opus fast mode");
    expect(card).toHaveTextContent(/Off by default/);
    expect(card).toHaveTextContent(/a subscription ignores the flag \(API only\)/);
    const effect = within(card).getByTestId("fast-mode-effect");
    expect(effect).toHaveTextContent(`On: ${ON}.`);
    expect(effect).toHaveTextContent(`Off: ${OFF}.`);
    const rows = await within(card).findAllByTestId("fast-mode-row");
    expect(rows.map((r) => r.dataset.project)).toEqual(["proj_atlas", "proj_beacon"]);
    const atlas = rows[0] as HTMLElement;
    const beacon = rows[1] as HTMLElement;
    await waitFor(() => expect(atlas).toHaveTextContent("Atlas"));
    expect(within(atlas).getByTestId("fast-mode-state")).toHaveTextContent("off");
    expect(within(atlas).getByTestId("fast-mode-toggle")).toHaveTextContent("Turn on");
    expect(within(beacon).getByTestId("fast-mode-state")).toHaveTextContent(
      "on: Opus runs at the fast-mode rate",
    );
    expect(within(beacon).getByTestId("fast-mode-toggle")).toHaveTextContent("Turn off");
  });

  it("without fast-mode rows from the daemon there is no card", async () => {
    renderApp("/settings");
    await screen.findAllByTestId("setting-row");
    expect(screen.queryByTestId("fast-mode-card")).not.toBeInTheDocument();
  });

  it("Turn on runs settings.set through the change card: the on effect and surcharge, a yes, the sentence", async () => {
    const user = userEvent.setup();
    const harness = fastHarness();
    renderApp("/settings", harness);
    const card = await screen.findByTestId("fast-mode-card");
    const atlas = (await within(card).findAllByTestId("fast-mode-row"))[0] as HTMLElement;
    await user.click(within(atlas).getByTestId("fast-mode-toggle"));
    const dialog = await screen.findByTestId("setting-dialog");
    expect(within(dialog).getByTestId("setting-value")).toHaveValue("true");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [
        { name: "settings.set", params: { key: "fast_mode", value: true, project: "proj_atlas" } },
      ],
      wordsUsed: "Settings: project.fast_mode to true",
      source: "ui",
      projectId: "proj_atlas",
    });
    // Medium risk: the card with what changes and what it costs, then a yes.
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_yes");
    expect(within(pending).getByTestId("change-card")).toHaveAttribute("data-risk", "medium");
    expect(within(pending).getByTestId("card-old")).toHaveTextContent("false");
    expect(within(pending).getByTestId("card-new")).toHaveTextContent(`true (${ON})`);
    await user.click(within(pending).getByTestId("command-yes"));
    const done = await within(dialog).findByTestId("command-done");
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      `Set Opus fast mode for Atlas from false to true: ${ON}.`,
    );
    expect(harness.daemon.state.fastMode.proj_atlas).toBe(true);
    // The change log keeps the sentence as said; the app shows it without "Undo." (U-074).
    expect(harness.daemon.state.changes[0]?.sentence).toBe(
      `Set Opus fast mode for Atlas from false to true: ${ON}. Undo.`,
    );
  });

  it("Turn off shows the off effect: back to the standard rate, the surcharge stops", async () => {
    const user = userEvent.setup();
    const harness = fastHarness();
    renderApp("/settings", harness);
    const card = await screen.findByTestId("fast-mode-card");
    const beacon = (await within(card).findAllByTestId("fast-mode-row"))[1] as HTMLElement;
    await user.click(within(beacon).getByTestId("fast-mode-toggle"));
    const dialog = await screen.findByTestId("setting-dialog");
    expect(within(dialog).getByTestId("setting-value")).toHaveValue("false");
    await user.click(within(dialog).getByTestId("setting-apply"));
    const pending = await within(dialog).findByTestId("command-pending");
    expect(within(pending).getByTestId("card-new")).toHaveTextContent(`false (${OFF})`);
    await user.click(within(pending).getByTestId("command-yes"));
    const done = await within(dialog).findByTestId("command-done");
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      `Set Opus fast mode for Beacon from true to false: ${OFF}.`,
    );
    expect(harness.daemon.state.fastMode.proj_beacon).toBe(false);
  });

  it("a project whose flag was never set reads off and its card says unset, as the daemon's does", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.fastMode = { proj_atlas: null };
    renderApp("/settings", harness);
    const card = await screen.findByTestId("fast-mode-card");
    const atlas = (await within(card).findAllByTestId("fast-mode-row"))[0] as HTMLElement;
    expect(within(atlas).getByTestId("fast-mode-state")).toHaveTextContent("off");
    await user.click(within(atlas).getByTestId("fast-mode-toggle"));
    const dialog = await screen.findByTestId("setting-dialog");
    expect(within(dialog).getByTestId("setting-value")).toHaveValue("true");
    await user.click(within(dialog).getByTestId("setting-apply"));
    const pending = await within(dialog).findByTestId("command-pending");
    expect(within(pending).getByTestId("card-old")).toHaveTextContent("unset");
    await user.click(within(pending).getByTestId("command-yes"));
    const done = await within(dialog).findByTestId("command-done");
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      `Set Opus fast mode for Atlas from unset to true: ${ON}.`,
    );
  });

  it("maps the row to settings.set with a boolean value, like every SETTING_SPECS key", () => {
    const row = {
      key: FAST_MODE_KEY,
      scope: "project" as const,
      scopeId: "proj_atlas",
      value: false,
      description: "",
      risk: "medium" as const,
    };
    expect(fastModeRows([row, { ...row, key: "project.autonomy" }])).toEqual([row]);
    const command = commandForSetting(row);
    expect(command?.name).toBe("settings.set");
    expect(command?.params("true")).toEqual({
      key: "fast_mode",
      value: true,
      project: "proj_atlas",
    });
  });
});
