import type { ProjectSessionRowView, SessionView } from "@forerunner/runtime/daemon/api-types";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/api/client.ts";
import type { EventSourceLike, StreamOptions } from "../src/api/sse.ts";
import { formatClock } from "../src/lib/time.ts";
import { createHarness, fetchFromApp, type Harness, renderApp, testConfig } from "./helpers.tsx";

/**
 * Project: Sessions (the owner's decision D2 of 2026-11-09, d1109-sessions, ADR 0116): "every
 * project has a list of its sessions (what each did, spent, how it ended), each opening the
 * session's page". Before, /projects/:id/sessions fell back to the Overview and only the last
 * session was anywhere on screen.
 */
const HOUR = 60 * 60_000;
const money = (chfMicro: number) => ({ usdMicro: Math.round(chfMicro / 0.8), chfMicro });

function row(over: Partial<ProjectSessionRowView> & { id: string }): ProjectSessionRowView {
  return {
    startedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    endedAt: new Date(Date.now() - 2 * HOUR + 12 * 60_000).toISOString(),
    durationMs: 12 * 60_000,
    working: false,
    planning: false,
    gist: "Nothing finished.",
    tasks: { done: 0, failed: 0, paused: 0, needsYou: 0, cancelled: 0, leftForYou: 0 },
    countsWords: "",
    endedWords: "Done",
    spent: money(50_000),
    spentWords: "CHF 0.05 on your API key",
    startedBy: null,
    ...over,
  };
}

/** A harness whose client records every address it asks for (what goes over the wire). */
function recording(harness: Harness = createHarness()) {
  const urls: string[] = [];
  const inner = fetchFromApp(harness.daemon.app);
  const client = createClient(testConfig("test-token"), (input, init) => {
    urls.push(String(input));
    return inner(input, init);
  });
  return { harness: { ...harness, client }, urls };
}

const atlasRows = (): ProjectSessionRowView[] => {
  const t = Date.now();
  return [
    row({
      id: "sess_1",
      startedAt: new Date(t - 1 * HOUR).toISOString(),
      gist: 'Did 2 tasks: "Index the documentation pages" and "Add the search box to the header".',
      tasks: { done: 2, failed: 0, paused: 0, needsYou: 0, cancelled: 0, leftForYou: 0 },
      countsWords: "2 done",
    }),
    row({
      id: "sess_stopped",
      startedAt: new Date(t - 2 * HOUR).toISOString(),
      durationMs: 30_000,
      gist: "Nothing finished.",
      endedWords: "Stopped by you",
      spent: money(3_000),
      spentWords: "less than CHF 0.01 on your API key",
    }),
    row({
      id: "sess_plan",
      startedAt: new Date(t - 3 * HOUR).toISOString(),
      durationMs: 60_000,
      planning: true,
      gist: "Drafted a plan of 4 tasks; you approved it.",
      endedWords: null,
      startedBy: null,
    }),
  ];
};

/** The daemon's streams from the fake daemon's listeners, open at once (as project-overview's). */
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

/** A session of Atlas working now on "Write the pipeline brief". */
function working(harness: Harness): SessionView {
  const s: SessionView = {
    id: "sess_live",
    agentId: "agent_alice",
    agentName: "Alice's agent",
    projectId: "proj_atlas",
    trigger: "manual",
    status: "running",
    startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    endedAt: null,
    budgetCap: money(4_000_000),
    spent: money(400_000),
    stepCap: 200,
    steps: 5,
    currentTask: { id: "task_4", title: "Write the pipeline brief", specialist: "writer" },
    summary: "",
    handoff: null,
    runner: "pc",
  };
  harness.daemon.state.sessions.push(s);
  return s;
}

describe("d1109-sessions, run C: the Sessions tab (SL-7)", () => {
  it("is first behind More and its address shows it, no redirect to the Overview", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/sessions");
    expect(await screen.findByTestId("tab-panel-sessions")).toBeInTheDocument();
    expect(await screen.findByTestId("sessions-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("summary-tab")).toBeNull();
    const more = screen.getByTestId("tab-more");
    expect(
      within(more)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Sessions", "Plan", "Docs", "Reviews", "Costs", "Data"]);
    // From the Overview, More then Sessions.
    await user.click(screen.getByTestId("tab-summary"));
    await screen.findByTestId("summary-tab");
    await user.click(within(screen.getByTestId("tab-more")).getByText("Sessions"));
    expect(await screen.findByTestId("sessions-tab")).toBeInTheDocument();
  });

  it("says the count, the working session on top in the project's words, one row per session with its second line, each opening its page", async () => {
    const user = userEvent.setup();
    const { harness, urls } = recording();
    harness.daemon.state.projectSessions.proj_atlas = atlasRows();
    working(harness);
    renderApp("/projects/proj_atlas/sessions", harness);
    const tab = await screen.findByTestId("sessions-tab");
    expect(await within(tab).findByTestId("sessions-heading")).toHaveTextContent(/^4 sessions$/);
    const live = within(tab).getByTestId("session-row-working");
    expect(within(live).getByTestId("session-row-gist")).toHaveTextContent(
      /^Working on "Write the pipeline brief" \(\d+ of \d+ done\)$/,
    );
    expect(within(live).getByTestId("session-row-line")).toHaveTextContent(
      /^\d\d:\d\d · 3 min · CHF 0\.40 so far on your API key$/,
    );
    const rows = within(tab).getAllByTestId("session-row");
    expect(rows.map((r) => within(r).getByTestId("session-row-gist").textContent)).toEqual([
      'Did 2 tasks: "Index the documentation pages" and "Add the search box to the header".',
      "Nothing finished.",
      "Drafted a plan of 4 tasks; you approved it.",
    ]);
    const first = harness.daemon.state.projectSessions.proj_atlas?.[0];
    expect(within(rows[0] as HTMLElement).getByTestId("session-row-line")).toHaveTextContent(
      `${formatClock(first?.startedAt)} · 12 min · 2 done · Done · CHF 0.05 on your API key`,
    );
    expect(within(rows[1] as HTMLElement).getByTestId("session-row-line")).toHaveTextContent(
      /^\d\d:\d\d · under a minute · Stopped by you · less than CHF 0\.01 on your API key$/,
    );
    expect(within(rows[2] as HTMLElement).getByTestId("session-row-line")).toHaveTextContent(
      /^\d\d:\d\d · 1 min · CHF 0\.05 on your API key$/,
    );
    // What the person reads: no total, no id, no raw state, no USD.
    const text = tab.textContent ?? "";
    expect(text).not.toMatch(/USD|sess_|total|in all|completed|stopped\b|running|needs_human/);
    expect(urls.some((u) => /\/projects\/proj_atlas\/sessions(\?|$)/.test(u))).toBe(true);
    // A row opens its session's page.
    await user.click(rows[0] as HTMLElement);
    expect(await screen.findByTestId("session-header")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Atlas · session at /),
    );
  });

  it("Show older sessions asks for the page after with its cursor, appends it, and is gone on the last", async () => {
    const user = userEvent.setup();
    const { harness, urls } = recording();
    const t = Date.now();
    harness.daemon.state.projectSessions.proj_atlas = Array.from({ length: 21 }, (_, i) =>
      row({
        id: `sess_${String(i).padStart(2, "0")}`,
        startedAt: new Date(t - (i + 1) * HOUR).toISOString(),
        gist: `Did 1 task: "Page ${i + 1}".`,
        countsWords: "1 done",
      }),
    );
    renderApp("/projects/proj_atlas/sessions", harness);
    const tab = await screen.findByTestId("sessions-tab");
    expect(await within(tab).findByTestId("sessions-heading")).toHaveTextContent("21 sessions");
    expect(within(tab).getAllByTestId("session-row")).toHaveLength(20);
    const older = within(tab).getByTestId("sessions-older");
    expect(older).toHaveTextContent("Show older sessions");
    const asked = urls.length;
    await user.click(older);
    await waitFor(() => expect(within(tab).getAllByTestId("session-row")).toHaveLength(21));
    const sent = urls.slice(asked).find((u) => u.includes("/projects/proj_atlas/sessions"));
    const before = new URL(sent ?? "http://x").searchParams.get("before");
    // The cursor is the last row's start and id, as the daemon writes it.
    expect(JSON.parse(Buffer.from(before ?? "", "base64url").toString("utf8"))).toEqual([
      harness.daemon.state.projectSessions.proj_atlas?.[19]?.startedAt,
      "sess_19",
    ]);
    expect(within(tab).getAllByTestId("session-row").at(-1)).toHaveTextContent('"Page 21"');
    expect(within(tab).queryByTestId("sessions-older")).toBeNull();
  });

  it("after Show older sessions, a session that ends keeps every row on screen once, in order, and Show older goes on from the oldest shown", async () => {
    // Review of d1109-sessions (bench walk9): with 22 rows shown, a session ended and the
    // heading said "23 sessions" over 22 rows; the 20th row of the old first page fell between
    // the re-read first page and the older page already shown, and Show older could not bring
    // it back. The ADR's rule: a session starting or ending meanwhile never shifts or repeats rows.
    const user = userEvent.setup();
    const { harness, urls } = recording();
    const t = Date.now();
    const ended = (i: number) =>
      row({
        id: `sess_${String(i).padStart(2, "0")}`,
        startedAt: new Date(t - (i + 1) * HOUR).toISOString(),
        gist: `Did 1 task: "Page ${i + 1}".`,
        countsWords: "1 done",
      });
    harness.daemon.state.projectSessions.proj_atlas = Array.from({ length: 45 }, (_, i) =>
      ended(i),
    );
    const s = working(harness);
    renderApp("/projects/proj_atlas/sessions", harness, liveEvents(harness));
    const tab = await screen.findByTestId("sessions-tab");
    const shown = () =>
      within(tab)
        .getAllByTestId("session-row")
        .map((r) => r.getAttribute("href"));
    await waitFor(() => expect(shown()).toHaveLength(20));
    await user.click(within(tab).getByTestId("sessions-older"));
    await waitFor(() => expect(shown()).toHaveLength(40));
    expect(within(tab).getByTestId("sessions-heading")).toHaveTextContent("46 sessions");

    // The working session ends: the daemon lists it first among the ended ones.
    s.status = "completed";
    harness.daemon.state.projectSessions.proj_atlas = [
      row({ id: "sess_live", startedAt: s.startedAt as string, gist: "Nothing finished." }),
      ...(harness.daemon.state.projectSessions.proj_atlas ?? []),
    ];
    await act(async () => {
      for (const l of harness.daemon.state.listeners) {
        l("session.changed", { ...s });
        l("project.changed", { id: "proj_atlas" });
      }
    });
    await waitFor(() => expect(within(tab).queryByTestId("session-row-working")).toBeNull(), {
      timeout: 10_000,
    });
    // Every session that was on screen still is, once, newest first, with the one that ended
    // on top; nothing older than the oldest shown row slipped in.
    const expected = [
      "/sessions/sess_live",
      ...Array.from({ length: 40 }, (_, i) => `/sessions/sess_${String(i).padStart(2, "0")}`),
    ];
    await waitFor(() => expect(shown()).toEqual(expected), { timeout: 10_000 });
    expect(within(tab).getByTestId("sessions-heading")).toHaveTextContent("46 sessions");

    // Show older goes on after the oldest row shown (sess_39), never repeating one.
    const asked = urls.length;
    await user.click(within(tab).getByTestId("sessions-older"));
    await waitFor(() => expect(shown()).toHaveLength(46));
    const sent = urls.slice(asked).find((u) => u.includes("before="));
    const before = new URL(sent ?? "http://x").searchParams.get("before");
    expect(JSON.parse(Buffer.from(before ?? "", "base64url").toString("utf8"))[1]).toBe("sess_39");
    expect(new Set(shown()).size).toBe(46);
    expect(shown().at(-1)).toBe("/sessions/sess_44");
    expect(within(tab).queryByTestId("sessions-older")).toBeNull();
  }, 30_000);

  it("with every session shown, one that ends makes the rows equal the count, and no Show older comes back", async () => {
    // The bench's case: 21 ended and one working; Show older brought the last one.
    const user = userEvent.setup();
    const harness = createHarness();
    const t = Date.now();
    harness.daemon.state.projectSessions.proj_atlas = Array.from({ length: 21 }, (_, i) =>
      row({
        id: `sess_${String(i).padStart(2, "0")}`,
        startedAt: new Date(t - (i + 1) * HOUR).toISOString(),
      }),
    );
    const s = working(harness);
    renderApp("/projects/proj_atlas/sessions", harness, liveEvents(harness));
    const tab = await screen.findByTestId("sessions-tab");
    const shown = () =>
      within(tab)
        .getAllByTestId("session-row")
        .map((r) => r.getAttribute("href"));
    await waitFor(() => expect(shown()).toHaveLength(20));
    await user.click(within(tab).getByTestId("sessions-older"));
    await waitFor(() => expect(shown()).toHaveLength(21));
    s.status = "completed";
    harness.daemon.state.projectSessions.proj_atlas = [
      row({ id: "sess_live", startedAt: s.startedAt as string }),
      ...(harness.daemon.state.projectSessions.proj_atlas ?? []),
    ];
    await act(async () => {
      for (const l of harness.daemon.state.listeners) l("project.changed", { id: "proj_atlas" });
    });
    await waitFor(() => expect(within(tab).queryByTestId("session-row-working")).toBeNull(), {
      timeout: 10_000,
    });
    await waitFor(() => expect(shown()).toHaveLength(22), { timeout: 10_000 });
    expect(within(tab).getByTestId("sessions-heading")).toHaveTextContent("22 sessions");
    expect(new Set(shown()).size).toBe(22);
    expect(shown()).toContain("/sessions/sess_19");
    expect(within(tab).queryByTestId("sessions-older")).toBeNull();
  }, 30_000);

  it("the working row follows the session: a new task and its project's change re-read it", async () => {
    const harness = createHarness();
    harness.daemon.state.projectSessions.proj_atlas = atlasRows();
    const s = working(harness);
    renderApp("/projects/proj_atlas/sessions", harness, liveEvents(harness));
    const tab = await screen.findByTestId("sessions-tab");
    const gist = () =>
      within(within(tab).getByTestId("session-row-working")).getByTestId("session-row-gist");
    await waitFor(() => expect(gist()).toHaveTextContent('Working on "Write the pipeline brief"'));
    // The session moves to the next task; the daemon says so on its frames.
    s.currentTask = { id: "task_1", title: "Index the documentation pages", specialist: "coder" };
    await act(async () => {
      for (const l of harness.daemon.state.listeners) {
        l("session.changed", { ...s });
        l("project.changed", { id: "proj_atlas" });
      }
    });
    await waitFor(
      () => expect(gist()).toHaveTextContent('Working on "Index the documentation pages"'),
      { timeout: 10_000 },
    );
  }, 15_000);

  it("an empty project says what the list will hold; chat about the project is one line with Open Chat", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.projectSessions.proj_atlas = [];
    renderApp("/projects/proj_atlas/sessions", harness);
    const tab = await screen.findByTestId("sessions-tab");
    expect(await within(tab).findByTestId("sessions-empty")).toHaveTextContent(
      "No sessions yet. Each session is listed here with what it did and what it cost.",
    );
    expect(within(tab).queryByTestId("sessions-heading")).toBeNull();
    expect(within(tab).queryByTestId("sessions-chat")).toBeNull();
    // With chat spend about the project.
    harness.daemon.state.projectSessions.proj_atlas = atlasRows();
    harness.daemon.state.projectSessionsChat.proj_atlas = {
      spent: money(30_000),
      words: "Chat about this project: CHF 0.03.",
    };
    await user.click(screen.getByTestId("tab-summary"));
    await user.click(within(screen.getByTestId("tab-more")).getByText("Sessions"));
    const again = await screen.findByTestId("sessions-tab");
    const chat = await within(again).findByTestId("sessions-chat");
    expect(chat).toHaveTextContent("Chat about this project: CHF 0.03. Open Chat");
    await user.click(within(chat).getByTestId("sessions-chat-open"));
    expect(await screen.findByTestId("tab-panel-chat")).toBeInTheDocument();
  });
});

describe("d1109-sessions, run C: the two ways to the list and the session's tasks (SL-8, SL-9)", () => {
  it("the Overview's Last result links All N sessions from two on, not with one", async () => {
    const harness = createHarness();
    harness.daemon.state.projectSessions.proj_atlas = atlasRows();
    renderApp("/projects/proj_atlas/summary", harness);
    const link = await screen.findByTestId("all-sessions");
    expect(link).toHaveTextContent("All 3 sessions");
    expect(link).toHaveAttribute("href", "/projects/proj_atlas/sessions");

    const one = createHarness();
    one.daemon.state.projectSessions.proj_atlas = atlasRows().slice(0, 1);
    const view = renderApp("/projects/proj_atlas/summary", one);
    await within(view.container).findByTestId("last-result");
    expect(within(view.container).queryByTestId("all-sessions")).toBeNull();
  });

  it("a session page links All sessions beside Open the project, and lists its tasks, each opening its drawer", async () => {
    const user = userEvent.setup();
    renderApp("/sessions/sess_1");
    const header = await screen.findByTestId("session-header");
    const all = await within(header).findByTestId("all-sessions");
    expect(all).toHaveTextContent("All sessions");
    expect(all).toHaveAttribute("href", "/projects/proj_atlas/sessions");
    expect(within(header).getByText("Open the project")).toBeInTheDocument();
    const section = await screen.findByTestId("session-tasks");
    expect(section).toHaveTextContent("Tasks in this session");
    const items = within(section).getAllByTestId("session-task");
    expect(items.map((i) => i.textContent)).toEqual([
      '"Index the documentation pages"DoneCHF 2.20',
      '"Add the search box to the header"Needed your answernow: Being reviewedCHF 3.60',
    ]);
    await user.click(within(items[0] as HTMLElement).getByTestId("session-task-open"));
    expect(await screen.findByTestId("tab-panel-tasks")).toBeInTheDocument();
    expect(await screen.findByTestId("task-drawer")).toBeInTheDocument();
  });

  it("a planning call's page is titled planning and lists no tasks", async () => {
    const harness = createHarness();
    harness.daemon.state.sessions.push({
      id: "sess_plan",
      agentId: "agent_alice",
      agentName: "Alice's agent",
      projectId: "proj_atlas",
      trigger: "manual",
      status: "completed",
      startedAt: "2026-10-19T18:40:00.000Z",
      endedAt: "2026-10-19T18:41:00.000Z",
      budgetCap: money(1_600_000),
      spent: money(0),
      stepCap: 4,
      steps: 1,
      currentTask: null,
      summary: "Drafted a plan of 4 tasks; you approved it.",
      handoff: null,
      runner: "pc",
      statusText: "Plan drafted",
      planning: true,
    });
    renderApp("/sessions/sess_plan", harness);
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Atlas · planning at /),
    );
    expect(screen.getByTestId("session-status")).toHaveTextContent("Plan drafted");
    expect(screen.getByTestId("session-summary")).toHaveTextContent(
      "Drafted a plan of 4 tasks; you approved it.",
    );
    expect(screen.queryByTestId("session-tasks")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/intake/);
  });
});
