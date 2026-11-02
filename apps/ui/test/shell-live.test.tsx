import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SessionView } from "../src/api/client.ts";
import { parseDaemonEvent } from "../src/api/sse.ts";
import { elapsedWords } from "../src/shell/ShellBars.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * The header while work runs (design §3.1, walk lifecycle 14-16, chain-and-failure 102): a
 * running session could not be found from the header, Home or the project page, and Stop all
 * was a red button whether anything ran or not. Now a chip says who works on what and opens the
 * session; Stop all shows only while something runs; the stopped bar offers Allow sessions
 * again and Continue where it stopped; without a Claude key one bar says so.
 */

const running = (h: ReturnType<typeof createHarness>, extra: Partial<SessionView> = {}) => {
  const base = h.daemon.state.sessions[0] as SessionView;
  const s: SessionView = {
    ...base,
    id: "sess_live",
    agentName: "Alice",
    status: "running",
    endedAt: null,
    startedAt: new Date(Date.now() - 3.5 * 60_000).toISOString(),
    currentTask: { id: "task_2", title: "Add the search box", specialist: "coder" },
    ...extra,
  };
  h.daemon.state.sessions.push(s);
  return s;
};

describe("the header while a session runs (design §3.1)", () => {
  it("a chip says who works on what for how long, and opens the session", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness, { pollIntervalMs: 40 });
    await screen.findAllByTestId("project-card");
    expect(screen.queryByTestId("running-chip")).toBeNull();
    running(harness);
    const chip = await screen.findByTestId("running-chip");
    expect(chip).toHaveTextContent('Alice is working on "Add the search box" · 3 min');
    await user.click(chip);
    expect(await screen.findByTestId("session-header")).toBeInTheDocument();
  });

  it("the chip goes when the session ends, without a reload", async () => {
    const harness = createHarness();
    const s = running(harness);
    renderApp("/", harness, { pollIntervalMs: 40 });
    await screen.findByTestId("running-chip");
    s.status = "completed";
    s.endedAt = new Date().toISOString();
    // The poll no longer lists it; the next card read says nothing works on the project.
    harness.daemon.state.requests.push({
      ...(harness.daemon.state.requests[0] as (typeof harness.daemon.state.requests)[0]),
      id: "req_new",
      status: "open",
    });
    await waitFor(() => expect(screen.queryByTestId("running-chip")).toBeNull());
  });

  it("Continue where it stopped allows sessions and starts again only the projects Stop all stopped (later #60)", async () => {
    // Before: it started a session on every project with work that could run, so stopping one
    // project and pressing it started (and spent on) the others too.
    const user = userEvent.setup();
    const harness = createHarness();
    // Atlas runs a session; Beacon has a ready task too, and no session.
    running(harness);
    const beaconTask = harness.daemon.state.tasks.find((t) => t.id === "task_4");
    if (!beaconTask) throw new Error("fixture changed");
    beaconTask.status = "ready";
    renderApp("/", harness, { pollIntervalMs: 40 });
    await user.click(await screen.findByTestId("kill-switch"));
    await user.click(await screen.findByTestId("kill-confirm-stop"));
    const bar = await screen.findByTestId("kill-banner");
    expect(bar).toHaveTextContent(
      "Sessions are stopped. No session starts until you allow it again.",
    );
    expect(within(bar).getByTestId("kill-resume")).toHaveTextContent("Allow sessions again");
    expect(within(bar).getByTestId("kill-continue")).toHaveAttribute(
      "title",
      "Lets sessions start again and starts again the work Stop all stopped",
    );
    await user.click(within(bar).getByTestId("kill-continue"));
    await waitFor(() => expect(postedCalls(harness, "/kill/resume")).toHaveLength(1));
    await waitFor(() => expect(postedCalls(harness, "/sessions")).toHaveLength(1));
    expect(postedCalls(harness, "/sessions")[0]?.body).toMatchObject({
      projectId: "proj_atlas",
      trigger: "manual",
    });
    await waitFor(() => expect(screen.queryByTestId("kill-banner")).toBeNull());
    // Beacon, which nothing stopped, got no session.
    expect(
      postedCalls(harness, "/sessions").filter(
        (c) => (c.body as { projectId?: string }).projectId === "proj_beacon",
      ),
    ).toEqual([]);
  });

  it("Continue where it stopped after a Stop all that stopped nothing starts nothing", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.killActive = true;
    renderApp("/", harness);
    const bar = await screen.findByTestId("kill-banner");
    await user.click(within(bar).getByTestId("kill-continue"));
    await waitFor(() => expect(postedCalls(harness, "/kill/resume")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("kill-banner")).toBeNull());
    expect(postedCalls(harness, "/sessions")).toEqual([]);
  });

  it("without a Claude key one bar says so, with Connect; with one there is no bar", async () => {
    const without = createHarness({ me: { provider: null } });
    const first = renderApp("/", without);
    expect(await screen.findByTestId("no-key-bar")).toHaveTextContent(
      "Claude is not connected: planning and tasks need it. You can still add tasks.",
    );
    expect(screen.getByTestId("no-key-connect")).toHaveAttribute("href", "/setup");
    first.unmount();
    renderApp("/", createHarness({ me: { provider: "anthropic" } }));
    await screen.findAllByTestId("project-card");
    expect(screen.queryByTestId("no-key-bar")).toBeNull();
  });

  it("the Inbox badge says how many cards need you, in words", async () => {
    renderApp("/");
    const badge = await screen.findByTestId("inbox-badge");
    await waitFor(() => expect(badge).toHaveAttribute("aria-label", "2 need you"));
  });
});

describe("the install-wide stream's session frame (wave 1 handoff)", () => {
  it("the daemon's real frame, { type, payload }, is read as what happened in a session, not dropped", () => {
    // What server.ts `onSession` writes on /events for every session event.
    const frame = JSON.stringify({
      type: "task.started",
      payload: { taskId: "t1", title: "Create index.html", specialist: "coder" },
    });
    expect(parseDaemonEvent("session.changed", frame)).toEqual({
      event: "session.activity",
      data: {
        type: "task.started",
        payload: { taskId: "t1", title: "Create index.html", specialist: "coder" },
      },
    });
    // One session's own stream still sends the live view.
    const view = createHarness().daemon.state.sessions[0];
    expect(parseDaemonEvent("session.changed", JSON.stringify(view))?.event).toBe(
      "session.changed",
    );
  });

  it("elapsed time reads in minutes and hours", () => {
    const now = Date.parse("2026-11-01T10:00:00Z");
    expect(elapsedWords("2026-11-01T09:59:40Z", now)).toBe("just started");
    expect(elapsedWords("2026-11-01T09:58:00Z", now)).toBe("2 min");
    expect(elapsedWords("2026-11-01T08:55:00Z", now)).toBe("1 h 5 min");
    expect(elapsedWords(null, now)).toBeNull();
  });
});
