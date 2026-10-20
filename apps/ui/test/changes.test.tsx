import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { commandNames, undoTone } from "../src/pages/ChangesPage.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Change log", () => {
  it("reads command names and undo tones", () => {
    expect(commandNames([{ name: "budget.set", params: {} }, "undo", 3])).toEqual([
      "budget.set",
      "undo",
      "?",
    ]);
    expect(undoTone("undoable")).toBe("good");
    expect(undoTone("undone")).toBe("info");
    expect(undoTone("irreversible")).toBe("warn");
  });

  it("lists every change with who asked, the words, the commands, before/after and the source", async () => {
    renderApp("/changes");
    const rows = await screen.findAllByTestId("change");
    expect(rows).toHaveLength(2);
    const first = rows[0];
    if (!first) throw new Error("no change");
    expect(first).toHaveAttribute("data-source", "voice");
    expect(within(first).getByTestId("change-sentence")).toHaveTextContent(
      "Raised tonight's session budget for Atlas from CHF 5 to CHF 20, until 06:00. Undo.",
    );
    expect(within(first).getByTestId("change-words")).toHaveTextContent(
      "give Atlas 20 francs tonight",
    );
    expect(first).toHaveTextContent("Alice");
    expect(first).toHaveTextContent("budget.set");
    expect(first).toHaveTextContent('"sessionBudgetChf": 5');
    expect(within(first).getByTestId("change-undo-state")).toHaveTextContent("undoable");
    expect(within(first).getByTestId("change-undo")).toBeInTheDocument();
    const second = rows[1];
    if (!second) throw new Error("no change");
    expect(within(second).getByTestId("change-undo-state")).toHaveTextContent("undone");
    expect(within(second).queryByTestId("change-undo")).not.toBeInTheDocument();
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
