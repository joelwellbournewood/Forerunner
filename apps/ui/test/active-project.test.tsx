import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * One active project for every channel (U-056). The header showed one project while chat,
 * voice and the phone used the one last switched by chat, so "add a task" landed in the other
 * project. Now the header's switcher and the palette run `project.switch` (the daemon records
 * it), and a project's own Chat tab speaks about that project for its turn.
 */
describe("one active project for every channel (U-056)", () => {
  const activeOnDaemon = (h: ReturnType<typeof createHarness>) =>
    h.daemon.state.projects.find((p) => p.active)?.id;

  it("the header's switcher runs project.switch, logged as ui, and the daemon records it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Atlas"));
    await user.click(screen.getByTestId("active-project"));
    await user.click(within(await screen.findByTestId("project-switcher")).getByText("Beacon"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [{ name: "project.switch", params: { project: "proj_beacon" } }],
      wordsUsed: "Switch project: Beacon",
      source: "ui",
    });
    await waitFor(() => expect(activeOnDaemon(harness)).toBe("proj_beacon"));
    expect(screen.getByTestId("active-project")).toHaveTextContent("Beacon");
    expect(harness.daemon.state.changes[0]).toMatchObject({
      source: "ui",
      commands: [{ name: "project.switch", params: { project: "proj_beacon" } }],
    });
  });

  it("the palette's Switch project runs the same command", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Atlas"));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByTestId("command-palette");
    await user.type(within(palette).getByTestId("command-input"), "switch beacon");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(activeOnDaemon(harness)).toBe("proj_beacon"));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({
      commands: [{ name: "project.switch", params: { project: "proj_beacon" } }],
      source: "ui",
    });
  });

  it("at start the header shows the project the daemon recorded, not this window's last choice", async () => {
    const harness = createHarness();
    // This window last showed Atlas; then voice or the phone switched to Beacon.
    harness.store.dispatch({ type: "activeProject", id: "proj_atlas" });
    for (const p of harness.daemon.state.projects) p.active = p.id === "proj_beacon";
    renderApp("/", harness);
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Beacon"));
  });

  it("switch by chat to Beacon, then Atlas's Chat tab: the task lands in Atlas and the header stays Beacon", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "switch to Beacon");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Beacon"));
    expect(activeOnDaemon(harness)).toBe("proj_beacon");

    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "add a task: write the Atlas README");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(postedCalls(harness, "/chat/stream")).toHaveLength(2));
    // What goes over the wire: this tab's project, marked as the tab's.
    expect(postedCalls(harness, "/chat/stream")[1]?.body).toMatchObject({
      projectId: "proj_atlas",
      projectTab: true,
      text: "add a task: write the Atlas README",
    });
    const agents = await screen.findAllByTestId("chat-agent");
    await waitFor(() =>
      expect(agents[1]).toHaveTextContent(
        'Created the ready task "write the Atlas README" in Atlas.',
      ),
    );
    const task = harness.daemon.state.tasks.find((t) => t.title === "write the Atlas README");
    expect(task?.projectId).toBe("proj_atlas");
    // The header still shows what chat, voice and the phone use.
    expect(screen.getByTestId("active-project")).toHaveTextContent("Beacon");
    expect(activeOnDaemon(harness)).toBe("proj_beacon");
  });

  it("opening a project page does not switch the active project", async () => {
    const harness = createHarness();
    renderApp("/projects/proj_beacon/summary", harness);
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Beacon");
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Atlas"));
    expect(postedCalls(harness, "/commands/execute")).toHaveLength(0);
    expect(activeOnDaemon(harness)).toBe("proj_atlas");
  });
});
