import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { commandNames, undoBadge } from "../src/pages/ChangesPage.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Change log", () => {
  it("reads command names and says what Undo can do, from the view", () => {
    expect(commandNames([{ name: "budget.set", params: {} }, "undo", 3])).toEqual([
      "budget.set",
      "undo",
      "?",
    ]);
    const row = { undoable: false, undoState: "undoable" as const };
    expect(undoBadge({ ...row, undoable: true })).toEqual({ label: "Can be undone", tone: "good" });
    // Stored as undoable, but the view says it would not work now (later #36).
    expect(undoBadge(row)).toEqual({ label: "Cannot be undone", tone: "warn" });
    expect(undoBadge({ undoable: false, undoState: "undone" })).toEqual({
      label: "Undone",
      tone: "info",
    });
    expect(undoBadge({ undoable: false, undoState: "expired" })).toEqual({
      label: "Reverted",
      tone: "neutral",
    });
    expect(undoBadge({ undoable: false, undoState: "irreversible" })).toEqual({
      label: "Cannot be undone",
      tone: "warn",
    });
    // A row that is itself an Undo ("Undone: quiet hours is back to off.") is no change that
    // cannot be undone: it has no badge, rather than one that reads like a refusal.
    expect(
      undoBadge({
        undoable: false,
        undoState: "irreversible",
        commands: [{ name: "undo", params: { change_log_id: "chg_1" } }],
      }),
    ).toBeNull();
  });

  it("lists every change with who asked, the words said, what changed and the source", async () => {
    renderApp("/changes");
    const rows = await screen.findAllByTestId("change");
    expect(rows).toHaveLength(2);
    const first = rows[0];
    if (!first) throw new Error("no change");
    expect(first).toHaveAttribute("data-source", "voice");
    // Design §5 rule 6: never "Undo." as text next to the Undo button.
    expect(within(first).getByTestId("change-sentence")).toHaveTextContent(
      /^Raised tonight's session budget for Atlas from CHF 5 to CHF 20, until 06:00\.$/,
    );
    expect(within(first).getByTestId("change-words")).toHaveTextContent(
      "give Atlas 20 francs tonight",
    );
    expect(first).toHaveTextContent("Alice");
    expect(within(first).getByTestId("change-source")).toHaveTextContent("Voice");
    // W15-48: what changed is the sentence; no command name, no before / after as JSON.
    expect(first).not.toHaveTextContent("budget.set");
    expect(first).not.toHaveTextContent('"sessionBudgetChf": 5');
    expect(within(first).getByTestId("change-undo-state")).toHaveTextContent("Can be undone");
    expect(within(first).getByTestId("change-undo")).toBeInTheDocument();
    const second = rows[1];
    if (!second) throw new Error("no change");
    expect(within(second).getByTestId("change-undo-state")).toHaveTextContent("Undone");
    expect(within(second).queryByTestId("change-undo")).not.toBeInTheDocument();
  });

  it("a row whose Undo would not work is never badged as undoable; a click in the app is no 'Said:' (later #36, #90)", async () => {
    // Before: every row read "undoable" (the stored state), "Cannot be undone now: …" ones too;
    // a Settings click read 'Said: "Settings: Quiet hours to from 12:00 to 18:00"'.
    const harness = createHarness();
    harness.daemon.state.changes.unshift({
      ...(harness.daemon.state.changes[0] as (typeof harness.daemon.state.changes)[number]),
      id: "chg_start",
      source: "ui",
      wordsUsed: "Start session",
      commands: [{ name: "session.start", params: { project: "proj_atlas" } }],
      sentence: "Started a session on Atlas with a budget of CHF 5.00. Undo.",
      undoState: "undoable",
      expiresAt: null,
      before: { session_id: null },
      after: { session_id: "sess_1", start_id: "start_1" },
    });
    renderApp("/changes", harness);
    const row = (await screen.findAllByTestId("change")).find(
      (r) => r.getAttribute("data-change-id") === "chg_start",
    ) as HTMLElement;
    expect(within(row).getByTestId("change-undo-state")).toHaveTextContent("Cannot be undone");
    expect(within(row).queryByTestId("change-undo")).toBeNull();
    expect(within(row).getByTestId("change-undo-blocked")).toHaveTextContent(
      "Cannot be undone now: the session this start began has already ended; there is nothing to undo.",
    );
    expect(within(row).getByTestId("change-sentence")).toHaveTextContent(
      /^Started a session on Atlas with a budget of CHF 5\.00\.$/,
    );
    expect(within(row).queryByTestId("change-words")).toBeNull();
    expect(row).not.toHaveTextContent("Said:");
    expect(row).not.toHaveTextContent(/\bundoable\b/);
  });

  it("undoes a change with one click and shows the undo row", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/changes", harness);
    const rows = await screen.findAllByTestId("change");
    await user.click(within(rows[0] as HTMLElement).getByTestId("change-undo"));
    await waitFor(() => expect(postedCalls(harness, "/changes/chg_2/undo")).toHaveLength(1));
    expect(await screen.findByTestId("changes-note")).toHaveTextContent(
      "Undone: Raised tonight's session budget for Atlas from CHF 5 to CHF 20, until 06:00.",
    );
    await waitFor(() => expect(screen.getAllByTestId("change")).toHaveLength(3));
    expect(screen.getAllByTestId("change")[0]).toHaveAttribute("data-undo-state", "irreversible");
    expect(screen.getAllByTestId("change")[1]).toHaveAttribute("data-undo-state", "undone");
  });

  it("filters by project and by undoable, and degrades when the route is missing", async () => {
    const user = userEvent.setup();
    renderApp("/changes");
    await screen.findAllByTestId("change");
    await user.selectOptions(screen.getByTestId("changes-project"), "proj_beacon");
    expect(await screen.findByTestId("changes-empty")).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId("changes-project"), "");
    await user.click(screen.getByTestId("changes-undoable"));
    await waitFor(() => expect(screen.getAllByTestId("change")).toHaveLength(1));

    renderApp("/changes", createHarness({ missingRoutes: ["/changes"] }));
    expect(await screen.findByTestId("route-missing")).toHaveTextContent("GET /changes");
  });
});
