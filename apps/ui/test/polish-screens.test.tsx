import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * polish-screens (wave 13): each screen says one thing once, at the boundary a person uses.
 * Each case clicks the control and reads what appears and what goes over the wire.
 */

describe("the project header and its tabs (later #56, #57)", () => {
  it("with ready tasks the header has one start button, not Continue beside Start session", async () => {
    // Before: "Ready to continue: 1 task ready [Continue]" and "[Start session]" opened the
    // same Start dialog.
    const user = userEvent.setup();
    const harness = createHarness();
    // Beacon gets a ready task and nothing waits on the person there.
    const draft = harness.daemon.state.tasks.find((t) => t.id === "task_4");
    if (!draft) throw new Error("fixture changed");
    draft.status = "ready";
    renderApp("/projects/proj_beacon/summary", harness);
    const header = await screen.findByTestId("project-header");
    await waitFor(() =>
      expect(within(header).getByTestId("project-status")).toHaveTextContent("Ready to continue"),
    );
    const starts = within(header)
      .getAllByRole("button")
      .filter((b) => /^(Continue|Start session|Start)$/.test(b.textContent ?? ""));
    expect(starts.map((b) => b.textContent)).toEqual(["Start session"]);
    await user.click(within(header).getByTestId("start-session"));
    expect(await screen.findByTestId("start-session-dialog")).toBeInTheDocument();
  });

  it("after Files, the Tasks tab link keeps the Tasks filters and drops the file's path", async () => {
    // Before: /files?path=script.js then Tasks gave /tasks?path=script.js.
    renderApp("/projects/proj_atlas/files?path=script.js&status=ready&who=coder&q=page");
    const tasks = await screen.findByTestId("tab-tasks");
    const href = new URL(tasks.getAttribute("href") ?? "", "http://x");
    expect(href.pathname).toBe("/projects/proj_atlas/tasks");
    expect(href.searchParams.get("path")).toBeNull();
    expect(href.searchParams.get("status")).toBe("ready");
    expect(href.searchParams.get("who")).toBe("coder");
    expect(href.searchParams.get("q")).toBe("page");
    // With no filter, no query at all.
    const files = screen.getByTestId("tab-files");
    expect(files.getAttribute("href")).not.toContain("path=");
  });

  it("an open task drawer's id is not carried to another tab", async () => {
    renderApp("/projects/proj_atlas/tasks?task=task_3");
    const files = await screen.findByTestId("tab-files");
    expect(files).toHaveAttribute("href", "/projects/proj_atlas/files");
  });
});

describe("the shell's palette and bars (later #59, #63)", () => {
  const palette = async () => {
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    return screen.findByTestId("command-palette");
  };
  const titles = (p: HTMLElement) =>
    within(p)
      .queryAllByTestId("command-item")
      .map((i) => i.textContent ?? "");

  it("lists Stop all only while something runs, asks once before stopping, then offers Allow sessions again", async () => {
    // Before: "Stop all sessions" was listed while nothing ran and stopped at once, without
    // the question the header's button asks; its other state read "Resume all sessions".
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness, { pollIntervalMs: 40 });
    await screen.findAllByTestId("project-card");
    let p = await palette();
    await user.type(within(p).getByTestId("command-input"), "stop");
    expect(titles(p).some((t) => /Stop all/.test(t))).toBe(false);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    // A session runs: the palette lists Stop all with how many run.
    const running = { ...harness.daemon.state.sessions[0], id: "sess_live", status: "running" };
    harness.daemon.state.sessions.push(running as (typeof harness.daemon.state.sessions)[0]);
    await screen.findByTestId("kill-switch");
    p = await palette();
    await user.type(within(p).getByTestId("command-input"), "stop all");
    expect(titles(p).filter((t) => /Stop all/.test(t))).toEqual([
      expect.stringContaining("Stop all (1 running)"),
    ]);
    await user.keyboard("{Enter}");
    // It asks once, with what it does; nothing is sent before the confirmation.
    expect(await screen.findByTestId("kill-confirm")).toHaveTextContent(
      "Stops every running session now. No session starts until you allow it again.",
    );
    expect(postedCalls(harness, "/kill")).toHaveLength(0);
    await user.click(screen.getByTestId("kill-confirm-stop"));
    await waitFor(() => expect(postedCalls(harness, "/kill")).toHaveLength(1));
    await screen.findByTestId("kill-banner");
    // Stopped: the palette offers the header's words, not "Resume all sessions".
    p = await palette();
    await user.type(within(p).getByTestId("command-input"), "sessions");
    const listed = titles(p);
    expect(listed.some((t) => t.includes("Allow sessions again"))).toBe(true);
    expect(listed.some((t) => /Resume all|Stop all/.test(t))).toBe(false);
    await user.type(within(p).getByTestId("command-input"), " again");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(postedCalls(harness, "/kill/resume")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("kill-banner")).toBeNull());
  });

  it("the no-key bar does not show on the setup page its Connect points to", async () => {
    const home = renderApp("/", createHarness({ me: { provider: null } }));
    expect(await screen.findByTestId("no-key-bar")).toBeInTheDocument();
    home.unmount();
    renderApp("/setup", createHarness({ me: { provider: null } }));
    expect(await screen.findByRole("heading", { name: /Set up Forerunner/ })).toBeInTheDocument();
    expect(screen.queryByTestId("no-key-bar")).toBeNull();
  });
});
