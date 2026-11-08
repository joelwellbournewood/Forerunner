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

// Kept for later describe blocks of this file.
void fireEvent;
void postedCalls;
