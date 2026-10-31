import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * New projects use the person's default autonomy (U-058): Settings saved it, yet a project
 * created in the app always started at 2. The dialog sends no level; the daemon reads the
 * default (its real-daemon case is in real-daemon.test.ts).
 */
describe("new projects start at the default autonomy (U-058)", () => {
  it("Settings → default autonomy 3, then New project: the project starts at autonomy 3", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const rows = await screen.findAllByTestId("setting-row");
    const row = rows.find((r) => r.dataset.key === "human.default_autonomy") as HTMLElement;
    expect(within(row).getByTestId("setting-label")).toHaveTextContent(
      "Default autonomy for new projects",
    );
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    await user.selectOptions(within(dialog).getByTestId("setting-value"), "3");
    await user.click(within(dialog).getByTestId("setting-apply"));
    const pending = await within(dialog).findByTestId("command-pending");
    await user.click(within(pending).getByTestId("command-yes"));
    await within(dialog).findByTestId("command-done");
    await user.click(within(dialog).getByTestId("command-close"));

    await user.click(screen.getByTestId("active-project"));
    await user.click(await screen.findByText("+ New project"));
    const create = await screen.findByTestId("new-project-dialog");
    await user.type(within(create).getByLabelText("Name"), "Gamma");
    await user.type(within(create).getByLabelText(/Goal/), "Ship it");
    await user.click(within(create).getByTestId("create-project"));
    await waitFor(() => expect(postedCalls(harness, "/projects")).toHaveLength(1));
    // The dialog names no level: the person's default applies.
    expect(postedCalls(harness, "/projects")[0]?.body).not.toHaveProperty("autonomyLevel");
    expect(await screen.findByTestId("project-header")).toHaveTextContent("autonomy 3");
  });
});
