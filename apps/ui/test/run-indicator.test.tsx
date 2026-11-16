import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningView, SessionView } from "../src/api/client.ts";
import type { EventSourceLike, StreamOptions } from "../src/api/sse.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * d1109-run-visible V-2 (D8, the owner, 2026-11-09: "it should at least be very clear to a user
 * when a run is ongoing. That should also be very visually clear no matter where the person
 * is."): one run indicator directly under the header on every page, in the daemon's words, with
 * Stop after this task, Stop now and Stop all; a waiting session with Cancel; live on
 * `run.changed`; the window's title while a session runs. Before: a small chip at the header's
 * end ('Alice is working on "X" · 2 min') and a red 'Stop all (1 running)' at the other end, the
 * chip cut at max-w-md and nothing for a review, a stop asked for or a session that waits.
 */

type Harness = ReturnType<typeof createHarness>;

/** The daemon's `/events` stream from the fake daemon's listeners, open at once (no polling). */
function liveEvents(harness: Harness): StreamOptions {
  const factory = (_url: string): EventSourceLike => {
    const listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
    const fromDaemon = (event: string, data: unknown) => {
      for (const l of listeners.get(event) ?? []) l({ data: JSON.stringify(data) } as MessageEvent);
    };
    const es: EventSourceLike & { readyState: number } = {
      readyState: 0,
      onerror: null,
      onopen: null,
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        es.readyState = 2;
        harness.daemon.state.listeners.delete(fromDaemon);
      },
    };
    harness.daemon.state.listeners.add(fromDaemon);
    queueMicrotask(() => {
      es.readyState = 1;
      es.onopen?.(new Event("open"));
    });
    return es;
  };
  return { eventSource: factory, setTimer: () => 0, clearTimer: () => {} };
}

/** A session of Atlas working now on "Add the search box". */
function running(h: Harness, extra: Partial<SessionView> = {}): SessionView {
  const base = h.daemon.state.sessions[0] as SessionView;
  const s: SessionView = {
    ...base,
    id: "sess_live",
    agentName: "Alice",
    projectId: "proj_atlas",
    status: "running",
    endedAt: null,
    startedAt: new Date(Date.now() - 3.5 * 60_000).toISOString(),
    currentTask: { id: "task_2", title: "Add the search box", specialist: "coder" },
    ...extra,
  };
  h.daemon.state.sessions.push(s);
  return s;
}

const WAITING: RunningView = {
  key: "wait:proj_beacon",
  sessionId: "sess_1",
  projectId: "proj_beacon",
  projectName: "Beacon",
  state: "waiting",
  what: "waiting until 15:40, then it goes on",
  text: "Beacon · waiting until 15:40, then it goes on",
  since: new Date().toISOString(),
  stop: [],
  cancel: true,
  nextProject: null,
  explain: null,
};

/** Every primary and More route, a project's tabs and a session page (V-2's acceptance). */
const ROUTES = [
  "/",
  "/inbox",
  "/settings",
  "/memory",
  "/extensions",
  "/changes",
  "/performance",
  "/updates",
  "/projects/proj_atlas",
  "/projects/proj_atlas/tasks",
  "/projects/proj_atlas/files",
  "/sessions/sess_live",
];

function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
  document.title = "";
  setWidth(1024);
});

describe("d1109-run-visible: the run indicator under the header (V-2)", () => {
  for (const width of [1280, 375])
    for (const route of ROUTES)
      it(`shows what runs on ${route} at ${width} px, outside the collapsed menu, with no chip and no header Stop all`, async () => {
        setWidth(width);
        const harness = createHarness();
        running(harness);
        renderApp(route, harness);
        const bar = await screen.findByTestId("run-indicator-bar");
        expect(within(bar).getByTestId("run-text")).toHaveTextContent(
          'Atlas · the coder works on "Add the search box"',
        );
        expect(within(bar).getByTestId("run-elapsed")).toHaveTextContent("3 min");
        expect(within(bar).getByTestId("run-stop")).toHaveTextContent("Stop ▾");
        // Directly under the header, never inside the menu that collapses on a narrow window.
        const header = screen.getByTestId("header");
        expect(header.contains(bar)).toBe(false);
        expect(header.nextElementSibling).toBe(bar);
        expect(screen.getByTestId("main-nav").contains(bar)).toBe(false);
        // The old parts are gone.
        expect(screen.queryByTestId("running-chip")).toBeNull();
        expect(within(header).queryByText(/Stop all/)).toBeNull();
        expect(document.title).toBe("● Atlas · Forerunner");
      });

  it("renders nothing and leaves the title alone when nothing runs or waits", async () => {
    const harness = createHarness();
    renderApp("/", harness);
    await screen.findAllByTestId("project-card");
    expect(screen.queryByTestId("run-indicator-bar")).toBeNull();
    expect(document.title).toBe("Forerunner");
  });

  it("the words open the session", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    running(harness);
    renderApp("/inbox", harness);
    const bar = await screen.findByTestId("run-indicator-bar");
    await user.click(within(bar).getByTestId("run-open"));
    expect(await screen.findByTestId("session-header")).toBeInTheDocument();
  });

  it("Stop after this task sends POST /sessions/:id/pause at once", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    running(harness);
    renderApp("/settings", harness);
    const bar = await screen.findByTestId("run-indicator-bar");
    await user.click(within(bar).getByTestId("run-stop"));
    const menu = screen.getByTestId("run-stop-menu");
    expect(within(menu).getByTestId("run-stop-head")).toHaveTextContent(
      'Atlas · the coder works on "Add the search box"',
    );
    expect(within(menu).getByTestId("run-stop-after")).toHaveTextContent(
      "Stop after this taskFinishes the current task, then ends.",
    );
    await user.click(within(menu).getByTestId("run-stop-after"));
    await waitFor(() => expect(postedCalls(harness, "/sessions/sess_live/pause")).toHaveLength(1));
    expect(postedCalls(harness, "/sessions/sess_live/stop")).toEqual([]);
    // The daemon's words follow: it stops after the task.
    await waitFor(() =>
      expect(within(bar).getByTestId("run-text")).toHaveTextContent(
        'Atlas · stops after "Add the search box"',
      ),
    );
  });

  it("Stop now asks once, then sends POST /sessions/:id/stop", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    running(harness);
    renderApp("/memory", harness);
    const bar = await screen.findByTestId("run-indicator-bar");
    await user.click(within(bar).getByTestId("run-stop"));
    await user.click(screen.getByTestId("run-stop-now"));
    expect(postedCalls(harness, "/sessions/sess_live/stop")).toEqual([]);
    expect(screen.getByTestId("stop-now-confirm")).toHaveTextContent(
      "Stops the current task at once. It goes back to Ready; what it wrote so far stays in the folder.",
    );
    await user.click(screen.getByTestId("run-stop-now-confirm"));
    await waitFor(() => expect(postedCalls(harness, "/sessions/sess_live/stop")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("run-indicator-bar")).toBeNull());
    expect(document.title).toBe("Forerunner");
  });

  it("Stop all asks once, then sends POST /kill and shows the stopped bar", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    running(harness);
    renderApp("/changes", harness);
    const bar = await screen.findByTestId("run-indicator-bar");
    await user.click(within(bar).getByTestId("run-stop"));
    await user.click(screen.getByTestId("kill-switch"));
    expect(postedCalls(harness, "/kill")).toEqual([]);
    expect(screen.getByTestId("kill-confirm")).toHaveTextContent(
      "Stops every running session now. No session starts until you allow it again.",
    );
    await user.click(screen.getByTestId("kill-confirm-stop"));
    await waitFor(() => expect(postedCalls(harness, "/kill")).toHaveLength(1));
    expect(postedCalls(harness, "/kill")[0]?.body).toMatchObject({ scope: "all" });
    expect(await screen.findByTestId("kill-banner")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("run-indicator-bar")).toBeNull());
  });

  it("a run.changed frame changes the words without a reload", async () => {
    const harness = createHarness();
    const s = running(harness);
    renderApp("/inbox", harness, liveEvents(harness));
    const bar = await screen.findByTestId("run-indicator-bar");
    expect(within(bar).getByTestId("run-text")).toHaveTextContent(
      'Atlas · the coder works on "Add the search box"',
    );
    const reviewing: RunningView = {
      key: s.id,
      sessionId: s.id,
      projectId: "proj_atlas",
      projectName: "Atlas",
      state: "reviewing",
      what: 'the critic checks "Add the search box"',
      text: 'Atlas · the critic checks "Add the search box"',
      since: s.startedAt,
      stop: ["after", "now", "all"],
      cancel: false,
      nextProject: null,
      explain: null,
    };
    await act(async () => {
      for (const l of harness.daemon.state.listeners) l("run.changed", [reviewing]);
    });
    await waitFor(() =>
      expect(within(bar).getByTestId("run-text")).toHaveTextContent(
        'Atlas · the critic checks "Add the search box"',
      ),
    );
  });

  it("a session that waits to go on shows its words with Cancel and no Stop; Cancel sends POST /projects/:id/continuation/cancel; the title stays", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.runningExtra = [WAITING];
    harness.daemon.state.credentialWaitNow.proj_beacon = {
      text: "Waits until 15:40 (your subscription's limit); then your session goes on.",
      save: null,
      kept: true,
    } as never;
    renderApp("/", harness);
    const bar = await screen.findByTestId("run-indicator-bar");
    const entry = within(bar).getByTestId("run-entry");
    expect(entry).toHaveAttribute("data-state", "waiting");
    expect(within(entry).getByTestId("run-text")).toHaveTextContent(
      "Beacon · waiting until 15:40, then it goes on",
    );
    expect(within(entry).queryByTestId("run-stop")).toBeNull();
    expect(within(entry).queryByTestId("run-elapsed")).toBeNull();
    expect(within(entry).getByTestId("run-cancel-explain")).toHaveTextContent(
      "Nothing starts when Claude is back; its tasks wait for your Start.",
    );
    expect(document.title).toBe("Forerunner");
    await user.click(within(entry).getByTestId("run-cancel"));
    await waitFor(() =>
      expect(postedCalls(harness, "/projects/proj_beacon/continuation/cancel")).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByTestId("run-indicator-bar")).toBeNull());
  });

  it("the critic's monthly check: Stop now and Stop all, and in the open form what it is for", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.runningExtra = [
      {
        key: "sess_cal",
        sessionId: "sess_cal",
        projectId: null,
        projectName: "Forerunner",
        state: "calibrating",
        what: "the critic's monthly check on known examples",
        text: "Forerunner · the critic's monthly check on known examples",
        since: new Date().toISOString(),
        stop: ["now", "all"],
        cancel: false,
        nextProject: null,
        explain:
          "Once a month the critic reviews examples whose right answers are known, so you see whether it still catches mistakes; it spends at most CHF 8.00 a month of its own budget.",
      },
    ];
    renderApp("/", harness);
    const bar = await screen.findByTestId("run-indicator-bar");
    expect(within(bar).getByTestId("run-text")).toHaveTextContent(
      "Forerunner · the critic's monthly check on known examples",
    );
    await user.click(within(bar).getByTestId("run-stop"));
    expect(screen.getByTestId("run-explain")).toHaveTextContent(
      "Once a month the critic reviews examples whose right answers are known, so you see whether it still catches mistakes; it spends at most CHF 8.00 a month of its own budget.",
    );
    expect(screen.queryByTestId("run-stop-after")).toBeNull();
    expect(screen.getByTestId("run-stop-now")).toBeInTheDocument();
    expect(screen.getByTestId("kill-switch")).toBeInTheDocument();
  });
});
