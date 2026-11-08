import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { formatClock, formatDateTime, formatTime } from "../src/lib/time.ts";
import { usableNow } from "../src/pages/BillingOrderSection.tsx";
import { money } from "./fixtures.ts";
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

describe("Home (later #61, P7-8)", () => {
  it("opening a project from Home writes nothing to Changes and switches nothing", async () => {
    // Before: the row's link ran project.switch ("Switch project: Beacon"), a row in Changes
    // for every look at a project.
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    const cards = await screen.findAllByTestId("project-card");
    const changesBefore = harness.daemon.state.changes.length;
    await user.click(within(cards[1] as HTMLElement).getByTestId("open-project"));
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Beacon");
    // The header names the project on screen all the same (design §3.1).
    expect(screen.getByTestId("active-project")).toHaveTextContent("Beacon");
    await new Promise((r) => setTimeout(r, 50));
    expect(postedCalls(harness, "/commands/execute")).toEqual([]);
    expect(harness.daemon.state.changes).toHaveLength(changesBefore);
    await user.click(screen.getByRole("link", { name: "Home" }));
    await screen.findAllByTestId("project-card");
    // Back on Home the active project is still the one the person chose.
    expect(screen.getByTestId("active-project")).toHaveTextContent("Atlas");
  });

  it("a card with nothing to answer offers its own button, not Answer: the refused key's Save a new key", async () => {
    // Before: every Needs you row said "Answer", the refused-key card too, whose one action is
    // to save a new key in the setup assistant.
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.requests.unshift({
      id: "req_refused",
      projectId: null,
      projectName: null,
      taskId: null,
      taskTitle: null,
      sessionId: null,
      kind: "info",
      why: "Anthropic refused your API key. Save a new one in Settings.",
      steps: [],
      options: [],
      blocking: true,
      risk: "low",
      changeCard: {
        key: "credential:refused",
        source_id: "bs_api_key_1",
        credential_kind: "api_key",
        title: "Anthropic refused your API key",
      },
      status: "open",
      answer: null,
      createdAt: "2026-11-03T14:00:00.000Z",
      version: 1,
    });
    renderApp("/", harness);
    const rows = await screen.findAllByTestId("home-card");
    const refused = rows.find((r) =>
      r.textContent?.includes("Anthropic refused your API key"),
    ) as HTMLElement;
    expect(within(refused).queryByText("Answer")).toBeNull();
    const own = within(refused).getByTestId("home-card-action");
    expect(own).toHaveTextContent("Save a new key");
    expect(own).toHaveAttribute("href", "/setup");
    // A card with something to answer keeps Answer, to its card in the Inbox.
    const other = rows.find((r) => r !== refused) as HTMLElement;
    expect(within(other).getByTestId("home-card-action")).toHaveTextContent("Answer");
    expect(within(other).getByTestId("home-card-action").getAttribute("href")).toMatch(
      /^\/inbox#card-/,
    );
    await user.click(own);
    expect(await screen.findByTestId("setup-page")).toBeInTheDocument();
  });
});

describe("times on a screen: 24-hour HH:MM, in a browser set to en-US (later #66, P7-9, P7-4)", () => {
  // A browser set to American English: every toLocale* call without a locale reads en-US.
  const asEnUs = () => {
    const time = Date.prototype.toLocaleTimeString;
    const date = Date.prototype.toLocaleDateString;
    const both = Date.prototype.toLocaleString;
    const spies = [
      vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(function (
        this: Date,
        l?: Intl.LocalesArgument,
        o?: object,
      ) {
        return time.call(this, l ?? "en-US", o);
      }),
      vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (
        this: Date,
        l?: Intl.LocalesArgument,
        o?: object,
      ) {
        return date.call(this, l ?? "en-US", o);
      }),
      vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (
        this: Date,
        l?: Intl.LocalesArgument,
        o?: object,
      ) {
        return both.call(this, l ?? "en-US", o);
      }),
    ];
    return () => {
      for (const s of spies) s.mockRestore();
    };
  };
  /** An instant at this local wall-clock time on 3 Nov 2026. */
  const at = (h: number, m: number, s = 0) => new Date(2026, 10, 3, h, m, s).toISOString();

  it("the session title and its log stamps read like 'Waits until 04:36', never '04:32:05 AM'", async () => {
    const restore = asEnUs();
    try {
      const harness = createHarness();
      const s = harness.daemon.state.sessions.find((x) => x.id === "sess_1");
      if (!s) throw new Error("fixture changed");
      s.startedAt = at(4, 36);
      for (const [i, e] of harness.daemon.state.events.entries())
        if (e.sessionId === "sess_1") e.at = at(16, 2 + i, 5);
      renderApp("/sessions/sess_1", harness);
      await waitFor(() =>
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
          "Atlas · session at 04:36",
        ),
      );
      const rows = await screen.findAllByTestId("event-row");
      const stamps = rows.map((r) => r.querySelector("span")?.textContent ?? "");
      expect(stamps.length).toBeGreaterThan(0);
      for (const t of stamps) expect(t).toMatch(/^1[6]:0\d$/);
      expect(screen.getByTestId("session-header")).not.toHaveTextContent(/AM|PM/);
    } finally {
      restore();
    }
  });

  it("Settings' 'Resting until' reads the same way: HH:MM today, '4 Nov, 04:36' another day", () => {
    const restore = asEnUs();
    try {
      const now = new Date(2026, 10, 3, 9, 0).getTime();
      expect(formatClock(at(4, 36), now)).toBe("04:36");
      expect(formatClock(new Date(2026, 10, 4, 16, 5).toISOString(), now)).toBe("4 Nov, 16:05");
      expect(formatTime(at(16, 2, 5))).toBe("16:02");
      expect(formatDateTime(at(4, 36))).toBe("3 Nov 2026, 04:36");
      const until = new Date(Date.now() + 60 * 60_000).toISOString();
      const resting = {
        blocked: "resting",
        restingUntil: until,
        kind: "api_key",
      } as unknown as Parameters<typeof usableNow>[0];
      // Before: "Resting until Nov 03, 2026, 04:36 AM (its usage limit)".
      expect(usableNow(resting)).toBe(
        `Resting until ${formatClock(until)} (its usage limit); waiting work starts by itself then`,
      );
      expect(usableNow(resting)).toMatch(/until (\d+ \w{3}, )?\d\d:\d\d \(/);
      expect(usableNow(resting)).not.toMatch(/AM|PM|2026/);
    } finally {
      restore();
    }
  });

  it("the stream badge reads plain words: 'Updates every 5 s' while it polls, nothing once the session ended", async () => {
    // Before: "polling every 5 s", "live", "finished" or the raw mode value.
    const harness = createHarness({ eventDelayMs: 2000 });
    const { session } = await harness.client.startSession({
      agentId: "agent_alice",
      projectId: "proj_atlas",
    });
    if (!session) throw new Error("the fake daemon started no session");
    const page = renderApp(`/sessions/${session.id}`, harness);
    await waitFor(() =>
      expect(screen.getByTestId("stream-mode")).toHaveTextContent("Updates every 5 s"),
    );
    expect(screen.getByTestId("stream-notice")).toHaveTextContent(
      "Live updates do not work here; the page checks every 5 s instead.",
    );
    page.unmount();
    // An ended session: its status badge says it; no stream badge.
    renderApp("/sessions/sess_1", createHarness());
    await screen.findAllByTestId("event-row");
    expect(screen.queryByTestId("stream-mode")).toBeNull();
    expect(screen.getByTestId("session-header")).not.toHaveTextContent(/finished|polling/);
  });
});

describe("the Start dialog counts right (later #48, #69, C-45, P7-16)", () => {
  const openDialog = async (harness: ReturnType<typeof createHarness>) => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    return { user, dialog: await screen.findByTestId("start-session-dialog") };
  };
  const readyTask = (harness: ReturnType<typeof createHarness>) => {
    const t = harness.daemon.state.tasks.find((x) => x.id === "task_3");
    if (!t) throw new Error("fixture changed");
    return t;
  };

  it("two tasks ready now: 'and 1 more', not 'as they become ready'", async () => {
    const harness = createHarness();
    const ready = readyTask(harness);
    ready.estimate = money(1_000_000);
    harness.daemon.state.tasks.push({
      ...ready,
      id: "task_two",
      title: "Write the FAQ",
      estimate: money(500_000),
      priority: "low",
    });
    const { dialog } = await openDialog(harness);
    // Before: "... and continues with up to 1 more as they become ready (about CHF 0.40)."
    expect(await within(dialog).findByTestId("start-session-plan")).toHaveTextContent(
      /^This session runs "Decide the versioning scheme" \(about CHF 0\.80\) and 1 more \(about CHF 0\.40\)\.$/,
    );
    expect(dialog).not.toHaveTextContent("as they become ready");
  });

  it("a stuck line names what holds it in words, never '(cancelled)' or '(draft)'", async () => {
    const harness = createHarness();
    const ready = readyTask(harness);
    ready.estimate = money(10_000_000);
    harness.daemon.state.tasks.push(
      { ...ready, id: "task_old", title: "Try the old approach", status: "cancelled" },
      { ...ready, id: "task_sketch", title: "Sketch the layout", status: "draft" },
      {
        ...ready,
        id: "task_follow",
        title: "Write the migration guide",
        estimate: money(0),
        dependsOn: ["task_old", "task_sketch"],
      },
    );
    const { dialog } = await openDialog(harness);
    const line = await within(dialog).findByTestId("start-session-waiting");
    expect(line).toHaveTextContent(
      '"Write the migration guide" waits on "Try the old approach", which was cancelled, and "Sketch the layout", which is a draft, so it cannot run. Change what it waits for on the Tasks tab.',
    );
    expect(dialog).not.toHaveTextContent(/\((ready|draft|failed|cancelled|needs_human)\)/);
  });

  it("two tasks larger than the work budget are one line, not one each", async () => {
    const harness = createHarness();
    const ready = readyTask(harness);
    ready.estimate = money(10_000_000);
    harness.daemon.state.tasks.push({
      ...ready,
      id: "task_big",
      title: "Port the app",
      estimate: money(12_000_000),
      priority: "low",
    });
    const { dialog } = await openDialog(harness);
    await within(dialog).findByTestId("start-session-cannot-run");
    const lines = within(dialog).getAllByTestId("start-session-over-budget");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent(
      '"Decide the versioning scheme" (about CHF 8.00) and "Port the app" (about CHF 9.60) each need more than this session\'s work budget of CHF 4.00 (the budget less a fifth kept for reviews). Give the session a larger budget, or the tasks smaller ones.',
    );
  });

  it("'the tasks that run first' sums only the tasks ordered before the one left out", async () => {
    const harness = createHarness();
    const ready = readyTask(harness);
    // Work budget CHF 4.00: "Decide" (2.40) runs, "About page" (2.40) does not fit after it,
    // "Contact page" (0.80, after it in the order) fits and runs.
    ready.estimate = money(3_000_000);
    harness.daemon.state.tasks.push(
      { ...ready, id: "task_about", title: "About page", priority: "low" },
      {
        ...ready,
        id: "task_small",
        title: "Contact page",
        estimate: money(10_000_000),
        budget: money(1_000_000),
        priority: "low",
      },
    );
    const { dialog } = await openDialog(harness);
    const left = await within(dialog).findByTestId("start-session-over-budget");
    // Before: "take about CHF 3.20", which added "Contact page", run after it.
    expect(left).toHaveTextContent(
      '"About page" (about CHF 2.40) may be left for next time: the tasks that run first take about CHF 2.40 of this session\'s work budget of CHF 4.00',
    );
  });

  it("after Start the dialog says it started, with no second Start beside it", async () => {
    const harness = createHarness({ eventDelayMs: 10 });
    const { user, dialog } = await openDialog(harness);
    await waitFor(() => expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled());
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    expect(await within(dialog).findByTestId("start-session-notice")).toHaveTextContent(
      "Started: the session works until nothing more can run",
    );
    // Before: an enabled Start stood beside "Started: …" once the check was read again.
    await new Promise((r) => setTimeout(r, 100));
    expect(within(dialog).queryByTestId("confirm-start-session")).toBeNull();
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).not.toContain("Start");
    expect(within(dialog).getByText("Close")).toBeInTheDocument();
    expect(postedCalls(harness, "/sessions")).toHaveLength(1);
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
