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
    // Design §3.6: Start is refused before it is pressed, with the reason and the button that
    // unblocks it; nothing is sent.
    expect(await within(dialog).findByTestId("start-session-blocked")).toHaveTextContent(
      "Sessions are stopped (Stop all), so nothing can start.",
    );
    expect(within(dialog).getByTestId("confirm-start-session")).toBeDisabled();
    // No "This session runs ..." above a Start that cannot run: the two would contradict.
    expect(within(dialog).queryByTestId("start-session-plan")).not.toBeInTheDocument();
    expect(postedCalls(harness, "/sessions")).toHaveLength(0);
    await user.click(within(dialog).getByTestId("start-session-unblock"));
    await waitFor(() => expect(postedCalls(harness, "/kill/resume")).toHaveLength(1));
    await waitFor(() => expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled());
    expect(within(dialog).getByTestId("start-session-plan")).toHaveTextContent("This session runs");
    // The daemon's own refusal still reads as such if Stop all lands in between.
    harness.daemon.state.killActive = true;
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    expect(await within(dialog).findByText(KILL_ACTIVE_START_MESSAGE)).toBeInTheDocument();
  });

  it("the Cancel-task dialog's buttons say Keep task and Cancel task", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    const rows = await screen.findAllByTestId("task-row");
    const open = rows.find((r) => within(r).queryByTestId("action-cancel")) as HTMLElement;
    await user.click(within(open).getByTestId("action-cancel"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByTestId("dismiss-action")).toHaveTextContent("Keep task");
    expect(within(dialog).getByTestId("confirm-action")).toHaveTextContent("Cancel task");
    expect(dialog).not.toHaveTextContent("Confirm");
    await user.click(within(dialog).getByTestId("dismiss-action"));
    await waitFor(() => expect(screen.queryByTestId("action-dialog")).not.toBeInTheDocument());
    expect(harness.daemon.state.calls.filter((c) => c.path.endsWith("/action"))).toEqual([]);
    await user.click(within(open).getByTestId("action-cancel"));
    await user.click(
      within(await screen.findByTestId("action-dialog")).getByTestId("confirm-action"),
    );
    await waitFor(() =>
      expect(harness.daemon.state.calls.filter((c) => c.path.endsWith("/action"))).toHaveLength(1),
    );
    expect(harness.daemon.state.calls.find((c) => c.path.endsWith("/action"))?.body).toMatchObject({
      action: "cancel",
    });
  });
});
