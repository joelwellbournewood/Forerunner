import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
