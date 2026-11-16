import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RUNS } from "./fixtures.ts";
import { createHarness, renderApp } from "./helpers.tsx";

/**
 * d1109-cred-screens, run C (CS-6, C5-left-1): a session that moved onto the API key at the
 * subscription's limit says so where the person looks: under the session's spend ('On your API
 * key since 14:20 (your subscription's limit): CHF 0.42 so far.'), as its result line once it
 * ended, and on the task drawer's run ('On your API key after your subscription's limit · CHF
 * 0.43'); a session that never moved shows none of these. The daemon writes every word
 * (GET /sessions/:id `switchLine`, GET /tasks/:id runs[].switchLine).
 */
describe("d1109-cred-screens, run C: the switch on the session page and the drawer (CS-6)", () => {
  it("the session page shows the switch line under its spend, and follows the daemon's line", async () => {
    const harness = createHarness();
    const s = harness.daemon.state.sessions.find((x) => x.id === "sess_1");
    if (!s) throw new Error("no sess_1 fixture");
    s.switchLine = "On your API key since 14:20 (your subscription's limit): CHF 0.42 so far.";
    renderApp("/sessions/sess_1", harness);
    expect(await screen.findByTestId("session-switch-line")).toHaveTextContent(
      "On your API key since 14:20 (your subscription's limit): CHF 0.42 so far.",
    );
  });

  it("an ended session reads its result line; a session that never moved shows none", async () => {
    const harness = createHarness();
    const s = harness.daemon.state.sessions.find((x) => x.id === "sess_1");
    if (!s) throw new Error("no sess_1 fixture");
    s.status = "completed";
    s.endedAt = "2026-10-19T22:00:00.000Z";
    s.switchLine =
      "Your API key took over at 14:20 (your subscription's limit): CHF 0.42 of CHF 0.62.";
    const { unmount } = renderApp("/sessions/sess_1", harness);
    expect(await screen.findByTestId("session-switch-line")).toHaveTextContent(
      "Your API key took over at 14:20 (your subscription's limit): CHF 0.42 of CHF 0.62.",
    );
    unmount();
    s.switchLine = null;
    renderApp("/sessions/sess_1", harness);
    await screen.findByTestId("session-spend");
    expect(screen.queryByTestId("session-switch-line")).toBeNull();
  });

  it("the drawer's run on the key says so; the other runs say nothing of it", async () => {
    const harness = createHarness();
    const work = RUNS.find((r) => r.taskId === "task_2") as (typeof RUNS)[number];
    harness.daemon.state.runs.unshift({
      ...work,
      id: "run_on_key",
      createdAt: "2026-04-01T12:00:00.000Z",
      switchLine: "On your API key after your subscription's limit · CHF 0.43",
    });
    renderApp("/projects/proj_atlas/tasks?task=task_2", harness);
    const drawer = await screen.findByTestId("task-drawer");
    await waitFor(() => expect(within(drawer).getAllByTestId("drawer-run").length).toBe(2));
    const lines = within(drawer).getAllByTestId("drawer-run-switch");
    expect(lines.map((l) => l.textContent)).toEqual([
      "On your API key after your subscription's limit · CHF 0.43",
    ]);
  });
});
