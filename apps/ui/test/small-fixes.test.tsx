import { KILL_ACTIVE_START_MESSAGE } from "@forerunner/runtime/daemon/api-types";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createStore } from "../src/store/store.ts";
import { createHarness, postedCalls, renderApp, testConfig } from "./helpers.tsx";

/** U-077: the small things a person meets in the app. */
describe("small fixes (U-077)", () => {
  it("the palette button says Ctrl+K on Windows and Linux", async () => {
    renderApp("/");
    await screen.findAllByTestId("project-card");
    expect(screen.getByTestId("palette-open")).toHaveTextContent("Ctrl+K");
    expect(screen.getByTestId("palette-open")).not.toHaveTextContent("⌘");
    expect(screen.getByTestId("palette-open")).toHaveAttribute("title", "Command palette (Ctrl+K)");
  });

  it("and ⌘K on macOS only", async () => {
    const harness = createHarness();
    const mac = {
      ...harness,
      store: createStore({ ...testConfig(), platform: "macos" }, harness.storage),
    };
    renderApp("/", mac);
    await screen.findAllByTestId("project-card");
    expect(screen.getByTestId("palette-open")).toHaveTextContent("⌘K");
  });

  it("the palette starts a session on the active project", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Atlas"));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByTestId("command-palette");
    await user.type(within(palette).getByTestId("command-input"), "start session");
    expect(palette).toHaveTextContent("Start session: Atlas");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByTestId("start-session-dialog");
    await user.click(within(dialog).getByRole("button", { name: /^Start/ }));
    await waitFor(() => expect(postedCalls(harness, "/sessions")).toHaveLength(1));
    expect(postedCalls(harness, "/sessions")[0]?.body).toMatchObject({ projectId: "proj_atlas" });
  });

  it("starting a session under Stop all says what to do, from the daemon's 409", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.killActive = true;
    renderApp("/projects/proj_atlas/summary", harness);
    await user.click(await screen.findByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    await user.click(within(dialog).getByRole("button", { name: /^Start/ }));
    expect(await within(dialog).findByText(KILL_ACTIVE_START_MESSAGE)).toBeInTheDocument();
  });

  it("the Cancel-task dialog's buttons say Keep task and Cancel task", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    const rows = await screen.findAllByTestId("task-row");
    const open = rows.find((r) => within(r).queryByTestId("transition-cancelled")) as HTMLElement;
    await user.click(within(open).getByTestId("transition-cancelled"));
    const dialog = await screen.findByTestId("transition-dialog");
    expect(within(dialog).getByTestId("dismiss-transition")).toHaveTextContent("Keep task");
    expect(within(dialog).getByTestId("confirm-transition")).toHaveTextContent("Cancel task");
    expect(dialog).not.toHaveTextContent("Confirm");
    await user.click(within(dialog).getByTestId("dismiss-transition"));
    await waitFor(() => expect(screen.queryByTestId("transition-dialog")).not.toBeInTheDocument());
    expect(harness.daemon.state.calls.filter((c) => c.path.endsWith("/transition"))).toEqual([]);
    await user.click(within(open).getByTestId("transition-cancelled"));
    await user.click(
      within(await screen.findByTestId("transition-dialog")).getByTestId("confirm-transition"),
    );
    await waitFor(() =>
      expect(harness.daemon.state.calls.filter((c) => c.path.endsWith("/transition"))).toHaveLength(
        1,
      ),
    );
    expect(
      harness.daemon.state.calls.find((c) => c.path.endsWith("/transition"))?.body,
    ).toMatchObject({ to: "cancelled" });
  });
});
