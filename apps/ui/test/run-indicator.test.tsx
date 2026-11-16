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
    // The review of d1109-run-visible: Stop now's line says what stopping the check does (it has
    // no task to send back to Ready, design §5 rule 9), and the tab names the check, not
    // "Forerunner · Forerunner".
    expect(screen.getByTestId("run-stop-now")).toHaveTextContent(
      "Stops the check at once. This month's report is not written.",
    );
    expect(screen.getByTestId("run-stop-now")).not.toHaveTextContent("Ready");
    await waitFor(() => expect(document.title).toBe("● The critic's monthly check · Forerunner"));
  });
});

/**
 * V-3 (the owner named "Home, the project"; design §3.2 and §3.4 keep Working now) and V-4 (the
 * Talk panel is a modal over the header): the same element elsewhere, and the project's one
 * sentence says what waits to start and when.
 */
describe("d1109-run-visible: Home, the Overview, the project's line and Talk (V-3, V-4)", () => {
  it("Home's Working now shows the bar's words and Stop in its block form", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    running(harness);
    renderApp("/", harness);
    const block = within(await screen.findByTestId("working-now")).getByTestId(
      "run-indicator-block",
    );
    expect(within(block).getByTestId("run-text")).toHaveTextContent(
      'Atlas · the coder works on "Add the search box"',
    );
    await user.click(within(block).getByTestId("run-stop"));
    await user.click(screen.getByTestId("run-stop-after"));
    await waitFor(() => expect(postedCalls(harness, "/sessions/sess_live/pause")).toHaveLength(1));
  });

  it("the Overview's Working now shows its project's entry only", async () => {
    const harness = createHarness();
    running(harness);
    harness.daemon.state.runningExtra = [WAITING];
    renderApp("/projects/proj_atlas", harness);
    const section = await screen.findByTestId("overview-working");
    const entries = within(section).getAllByTestId("run-entry");
    expect(entries.map((e) => within(e).getByTestId("run-text").textContent)).toEqual([
      'Atlas · the coder works on "Add the search box"',
    ]);
    expect(within(section).getByTestId("run-stop")).toBeInTheDocument();
  });

  it("the project's line: the person's session waiting to go on, with Cancel; after Cancel the tasks wait for the Start", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const beaconTask = harness.daemon.state.tasks.find((t) => t.id === "task_4");
    if (!beaconTask) throw new Error("fixture changed");
    beaconTask.status = "ready";
    harness.daemon.state.startsWait.proj_beacon = {
      kind: "continuation",
      head: "Waiting until 15:40 (your subscription's limit)",
    };
    harness.daemon.state.runningExtra = [WAITING];
    renderApp("/projects/proj_beacon", harness);
    const header = await screen.findByTestId("project-header");
    await waitFor(() =>
      expect(within(header).getByTestId("project-status")).toHaveTextContent(
        "Waiting until 15:40 (your subscription's limit), then it goes on",
      ),
    );
    const cancel = within(header).getByTestId("project-status-action");
    expect(cancel).toHaveTextContent("Cancel");
    expect(cancel).toHaveAttribute(
      "title",
      "Nothing starts when Claude is back; its tasks wait for your Start.",
    );
    await user.click(cancel);
    await waitFor(() =>
      expect(postedCalls(harness, "/projects/proj_beacon/continuation/cancel")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(within(header).getByTestId("project-status")).toHaveTextContent(
        /^Ready: 1 task waits for your Start$/,
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("run-indicator-bar")).toBeNull());
  });

  it("the project's line: a kept Start with Cancel, a held hands-off start, a person start behind another session", async () => {
    const harness = createHarness();
    harness.daemon.state.startsWait.proj_beacon = {
      kind: "kept_start",
      head: "Starts at 15:40 (your subscription's limit)",
    };
    const { unmount } = renderApp("/projects/proj_beacon", harness);
    const header = await screen.findByTestId("project-header");
    await waitFor(() =>
      expect(within(header).getByTestId("project-status")).toHaveTextContent(
        /^Starts at 15:40 \(your subscription's limit\)$/,
      ),
    );
    expect(within(header).getByTestId("project-status-action")).toHaveTextContent("Cancel");
    // Nothing runs for a kept Start yet: the bar shows nothing.
    expect(screen.queryByTestId("run-indicator-bar")).toBeNull();
    unmount();
    harness.daemon.state.startsWait.proj_beacon = { kind: "held" };
    const second = renderApp("/projects/proj_beacon", harness);
    await waitFor(() =>
      expect(
        within(screen.getByTestId("project-header")).getByTestId("project-status"),
      ).toHaveTextContent(/^Starts after your quiet hours$/),
    );
    second.unmount();
    harness.daemon.state.startsWait.proj_beacon = { kind: "queued", behind: "Atlas" };
    renderApp("/projects/proj_beacon", harness);
    await waitFor(() =>
      expect(
        within(screen.getByTestId("project-header")).getByTestId("project-status"),
      ).toHaveTextContent(/^Starts after the session on "Atlas"$/),
    );
  });

  // The review of d1109-run-visible (blocking 4): a Start pressed on Beacon while Atlas's session
  // runs waits behind it; the bar's frame changes only its nextProject ('· then Beacon'), and
  // Beacon's own line kept saying it waits for your Start until a reload.
  it("the project's line follows a start that waits behind another session, without a reload", async () => {
    const harness = createHarness();
    const s = running(harness);
    renderApp("/projects/proj_beacon", harness, liveEvents(harness));
    const header = await screen.findByTestId("project-header");
    await waitFor(() =>
      expect(within(header).getByTestId("project-status")).not.toHaveTextContent(/^Starts after/),
    );
    harness.daemon.state.startsWait.proj_beacon = { kind: "queued", behind: "Atlas" };
    const atlas: RunningView = {
      key: s.id,
      sessionId: s.id,
      projectId: "proj_atlas",
      projectName: "Atlas",
      state: "working",
      what: 'the coder works on "Add the search box"',
      text: 'Atlas · the coder works on "Add the search box" · then Beacon',
      since: s.startedAt,
      stop: ["after", "now", "all"],
      cancel: false,
      nextProject: "Beacon",
      explain: null,
    };
    await act(async () => {
      for (const l of harness.daemon.state.listeners) l("run.changed", [atlas]);
    });
    await waitFor(() =>
      expect(within(header).getByTestId("project-status")).toHaveTextContent(
        /^Starts after the session on "Atlas"$/,
      ),
    );
    // The waiting start is dropped: the frame drops '· then Beacon', and the line follows again.
    delete harness.daemon.state.startsWait.proj_beacon;
    await act(async () => {
      for (const l of harness.daemon.state.listeners)
        l("run.changed", [
          { ...atlas, text: 'Atlas · the coder works on "Add the search box"', nextProject: null },
        ]);
    });
    await waitFor(() =>
      expect(within(header).getByTestId("project-status")).not.toHaveTextContent(/^Starts after/),
    );
  });

  it("Talk's first line says what runs, with the same Stop", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    running(harness);
    renderApp("/", harness);
    await screen.findByTestId("run-indicator-bar");
    await user.click(screen.getByTestId("talk-open"));
    const panel = await screen.findByTestId("conversation");
    const line = within(panel).getByTestId("run-indicator-compact");
    expect(within(line).getByTestId("run-text")).toHaveTextContent(
      'Atlas · the coder works on "Add the search box"',
    );
    await user.click(within(line).getByTestId("run-stop"));
    await user.click(within(panel).getByTestId("run-stop-after"));
    await waitFor(() => expect(postedCalls(harness, "/sessions/sess_live/pause")).toHaveLength(1));
  });
});

/**
 * V-5 (the owner's decision of 2026-11-09: the person's session goes on by itself when its Claude
 * credential is back, shown with Cancel) and C3-left-7's Continue: the page of a session that
 * ended to wait says what comes next with its one button. L3-left-15: the log's level chips in
 * words, none for a level with no line.
 */
describe("d1109-run-visible: the page of a session that ended to wait (V-5), its level chips (L3-left-15)", () => {
  const GOES_ON = {
    state: "goes_on" as const,
    text: 'Waiting until 15:40 (your subscription\'s limit), then it goes on with "B" and 1 more.',
    action: "cancel" as const,
    explain: "Nothing starts when Claude is back; its tasks wait for your Start.",
    projectId: "proj_atlas",
    budgetLeft: { usdMicro: 1_500_000, chfMicro: 1_200_000 },
  };
  const STOPPED = {
    state: "stopped" as const,
    text: 'Stopped to wait for your subscription\'s limit until 15:40: "B" and 1 more wait.',
    action: "continue" as const,
    explain: "Opens Start with the rest of this session and the CHF 1.20 left of its budget.",
    projectId: "proj_atlas",
    budgetLeft: { usdMicro: 1_500_000, chfMicro: 1_200_000 },
  };
  const waited = (h: Harness): SessionView => {
    const s = h.daemon.state.sessions[0] as SessionView;
    s.status = "completed";
    s.stopReason = "credential_wait";
    s.projectId = "proj_atlas";
    s.waitBlock = GOES_ON;
    h.daemon.state.waitBlockAfterCancel[s.id] = STOPPED;
    return s;
  };

  it("goes on by itself: the wait with Cancel; Cancel sends POST /projects/:id/continuation/cancel and then offers Continue with the budget left", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const s = waited(harness);
    renderApp(`/sessions/${s.id}`, harness);
    const block = await screen.findByTestId("session-wait");
    expect(within(block).getByTestId("session-wait-text")).toHaveTextContent(GOES_ON.text);
    expect(within(block).getByTestId("session-wait-explain")).toHaveTextContent(GOES_ON.explain);
    await user.click(within(block).getByTestId("session-wait-cancel"));
    await waitFor(() =>
      expect(postedCalls(harness, "/projects/proj_atlas/continuation/cancel")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("session-wait")).getByTestId("session-wait-text"),
      ).toHaveTextContent(STOPPED.text),
    );
    expect(screen.getByTestId("session-wait-explain")).toHaveTextContent(
      "Opens Start with the rest of this session and the CHF 1.20 left of its budget.",
    );
    // Continue opens Start with what is left of the budget and goes on with this session.
    await user.click(screen.getByTestId("session-wait-continue"));
    const dialog = await screen.findByTestId("start-session-dialog");
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/Session budget/)).toHaveValue("1.20"),
    );
    // The review of d1109-run-visible: the hint says what is filled in (not "the project's
    // default"), and that the daemon goes on with no more than that.
    expect(dialog).toHaveTextContent(
      "What is left of that session's budget is filled in: it goes on with that, never more.",
    );
    expect(dialog).not.toHaveTextContent("The project's default is filled in.");
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    await waitFor(() => expect(postedCalls(harness, "/sessions")).toHaveLength(1));
    expect(postedCalls(harness, "/sessions")[0]?.body).toMatchObject({
      projectId: "proj_atlas",
      continues: s.id,
    });
  });

  it("a Start kept for the reset: 'Starts again at 15:40 ...' with Cancel, which then reads 'Ready: it runs at your next Start.'", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const s = waited(harness);
    s.waitBlock = {
      ...GOES_ON,
      state: "starts_again",
      text: 'Starts again at 15:40 with "B" and 1 more.',
    };
    harness.daemon.state.waitBlockAfterCancel[s.id] = STOPPED;
    renderApp(`/sessions/${s.id}`, harness);
    const block = await screen.findByTestId("session-wait");
    expect(within(block).getByTestId("session-wait-text")).toHaveTextContent(
      'Starts again at 15:40 with "B" and 1 more.',
    );
    await user.click(within(block).getByTestId("session-wait-cancel"));
    await waitFor(() =>
      expect(screen.getByTestId("session-wait-text")).toHaveTextContent(
        "Ready: it runs at your next Start.",
      ),
    );
  });

  it("the level chips read in words, with no chip for a level with no line", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const s = harness.daemon.state.sessions[0] as SessionView;
    renderApp(`/sessions/${s.id}`, harness);
    await screen.findByTestId("session-header");
    await user.click(await screen.findByTestId("details-toggle"));
    const info = await screen.findByTestId("filter-info");
    expect(info.textContent).toMatch(/^Updates \(\d+\)$/);
    for (const level of ["warning", "escalation", "error"]) {
      const chip = screen.queryByTestId(`filter-${level}`);
      if (chip) expect(chip.textContent).not.toMatch(/\(0\)$/);
    }
    expect(document.body.textContent ?? "").not.toMatch(/\b(info|escalation) \(\d+\)/);
  });
});

describe("d1109-run-visible: the Inbox's Done line offers Start (V-6)", () => {
  /** Atlas's failed-task card, as `/inbox` serves it after the last try. */
  const retryCard = () => ({
    id: "req_retry",
    projectId: "proj_atlas",
    projectName: "Atlas",
    taskId: "task_3",
    taskTitle: "Decide the versioning scheme",
    sessionId: "sess_1",
    kind: "approval",
    why: '"Decide the versioning scheme" failed 4 times. The writer said: "The work needs something I do not have here."',
    steps: ["[high] The worker changed nothing: Do the work the brief asks for."],
    options: ["Try again", "Mark done anyway", "Cancel task"],
    blocking: true,
    risk: "high" as const,
    changeCard: {
      key: "critic:signoff",
      task_id: "task_3",
      review_id: "rev_1",
      run_id: "run_1",
      finding_ids: ["f_1"],
      reason: "retry_ladder_exhausted",
      title: '"Decide the versioning scheme" failed 4 times',
      said: "The work needs something I do not have here.",
      said_by: "writer",
      applied_at: null,
    },
    status: "open",
    answer: null,
    createdAt: "2026-10-31T09:00:00.000Z",
    version: 1,
  });
  const setUp = () => {
    const harness = createHarness();
    harness.daemon.state.requests.unshift(retryCard());
    const t3 = harness.daemon.state.tasks.find((t) => t.id === "task_3");
    if (t3) t3.status = "needs_human";
    return harness;
  };
  const press = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    const card = (await screen.findAllByTestId("request")).find(
      (r) => r.getAttribute("data-request-id") === "req_retry",
    ) as HTMLElement;
    await user.click(within(card).getByRole("button", { name: label }));
    const yes = screen.queryByTestId("choice-confirm-yes");
    if (yes) await user.click(yes);
    return screen.findByTestId("done-line");
  };

  it("an answer that readies work for the next Start offers Start beside its Done line; Start opens that project's Start dialog", async () => {
    const user = userEvent.setup();
    const harness = setUp();
    renderApp("/inbox", harness, liveEvents(harness));
    const done = await press(user, "Try again");
    expect(done).toHaveTextContent(
      'Done: Trying "Decide the versioning scheme" again: it runs at your next Start.',
    );
    const start = await within(done).findByTestId("done-line-start");
    expect(start).toHaveTextContent("Start");
    expect(within(done).getByTestId("done-line-start-explain")).toHaveTextContent(
      "Opens Start for Atlas.",
    );
    await user.click(start);
    const dialog = await screen.findByTestId("start-session-dialog");
    expect(dialog).toHaveTextContent("Start a session");
    // Nothing starts until the person presses the dialog's own Start.
    expect(postedCalls(harness, "/sessions")).toHaveLength(0);
  });

  it("never while a session of that project runs: Start goes when one starts, and comes back when it ends", async () => {
    const user = userEvent.setup();
    const harness = setUp();
    renderApp("/inbox", harness, liveEvents(harness));
    const done = await press(user, "Try again");
    await within(done).findByTestId("done-line-start");
    const live: RunningView = {
      key: "sess_live",
      sessionId: "sess_live",
      projectId: "proj_atlas",
      projectName: "Atlas",
      state: "working",
      what: 'the coder works on "Decide the versioning scheme"',
      text: 'Atlas · the coder works on "Decide the versioning scheme"',
      since: new Date().toISOString(),
      stop: ["after", "now", "all"],
      cancel: false,
      nextProject: null,
      explain: null,
    };
    await act(async () => {
      for (const l of harness.daemon.state.listeners) l("run.changed", [live]);
    });
    await waitFor(() => expect(within(done).queryByTestId("done-line-start")).toBeNull());
    await act(async () => {
      for (const l of harness.daemon.state.listeners) l("run.changed", []);
    });
    expect(await within(done).findByTestId("done-line-start")).toBeInTheDocument();
  });

  it("no Start for an answer that readied nothing (Cancel task)", async () => {
    const user = userEvent.setup();
    const harness = setUp();
    renderApp("/inbox", harness, liveEvents(harness));
    const done = await press(user, "Cancel task");
    expect(done).toHaveTextContent(/^Done: /);
    expect(within(done).queryByTestId("done-line-start")).toBeNull();
  });
});
