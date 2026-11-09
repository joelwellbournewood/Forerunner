import { webAccessWords } from "@forerunner/runtime/wiring/web-access";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { formatClock, formatDateTime, formatTime } from "../src/lib/time.ts";
import { usableNow } from "../src/pages/BillingOrderSection.tsx";
import { shortQuestion } from "../src/pages/project/DecisionsSection.tsx";
import { WebAccessInput } from "../src/pages/WebAccessInput.tsx";
import { DECISIONS, money } from "./fixtures.ts";
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

  it("two tasks larger than the work budget: the first runs with the warning, the second is one line of why it waits", async () => {
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
    // d1109-oversize-start (D4): before, both were one line telling the person to give the
    // session a larger budget, or the tasks smaller ones, with Start off.
    expect(within(dialog).queryByTestId("start-session-cannot-run")).toBeNull();
    expect(await within(dialog).findByTestId("start-session-oversized")).toHaveTextContent(
      '"Decide the versioning scheme" needs about CHF 8.00, more than this session\'s work budget of CHF 4.00: it works until that budget is used, keeps its work, and asks you to continue.',
    );
    const lines = within(dialog).getAllByTestId("start-session-over-budget");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent(
      '"Port the app" needs about CHF 9.60, more than this session\'s work budget: one task that large runs a session, so it waits for the next one.',
    );
    expect(dialog).not.toHaveTextContent("smaller ones");
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

  it("after Start, what Start would do and its fields go: only what happened stays", async () => {
    // Review of P7-16: after Start the dialog read the start check again and still said "This
    // session runs …" for a session that would not start, above a budget and a note that
    // nothing would use.
    const harness = createHarness({ eventDelayMs: 10 });
    const { user, dialog } = await openDialog(harness);
    await within(dialog).findByTestId("start-session-plan");
    await waitFor(() => expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled());
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    await within(dialog).findByTestId("start-session-notice");
    await new Promise((r) => setTimeout(r, 100));
    expect(within(dialog).queryByTestId("start-session-plan")).toBeNull();
    expect(within(dialog).queryByLabelText(/Session budget/)).toBeNull();
    expect(within(dialog).queryByLabelText(/Note for this session/)).toBeNull();
    expect(within(dialog).getByTestId("start-session-open")).toHaveTextContent("Open the session");
  });
});

describe("Settings says what is true (later #43, P7-32, W14-8)", () => {
  it("'Saved as:' lists every site before saving, all seven", () => {
    const sites = ["a.com", "b.org", "c.net", "d.io", "e.ch", "f.de", "g.fr"];
    render(
      <WebAccessInput
        value={JSON.stringify({ mode: "only", only: sites.join("\n"), never: "" })}
        onChange={() => {}}
      />,
    );
    // Before: "Only these websites: a.com, b.org, c.net, d.io, e.ch and 2 more".
    expect(screen.getByTestId("web-access-saved-as")).toHaveTextContent(
      "only a.com, b.org, c.net, d.io, e.ch, f.de and g.fr",
    );
  });

  it("an 'only' list the clean-up left empty reads 'no website', never 'Only these websites: none'", () => {
    expect(webAccessWords({ mode: "only", only: [], never: [] })).toBe("no website");
    expect(webAccessWords({ mode: "only", only: ["a.com"], never: ["b.com"] })).toBe(
      "only a.com; never b.com",
    );
  });

  it("a project without a budget reads 'no budget' on its row, never 'CHF 0.00'", async () => {
    const harness = createHarness();
    const atlas = harness.daemon.state.projects.find((p) => p.id === "proj_atlas");
    if (!atlas) throw new Error("fixture changed");
    atlas.budget = money(0);
    renderApp("/settings", harness);
    const rows = await screen.findAllByTestId("setting-row");
    const row = rows.find(
      (r) =>
        r.dataset.key === "project.budget" &&
        within(r).getByTestId("setting-scope").textContent?.includes("Atlas"),
    ) as HTMLElement;
    expect(within(row).getByTestId("setting-value-cell")).toHaveTextContent(/^no budget$/);
  });

  it("a project's budget takes 0 as no budget and says so; the monthly cap's 0 is refused with why", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const rows = await screen.findAllByTestId("setting-row");
    const row = rows.find(
      (r) =>
        r.dataset.key === "project.budget" &&
        within(r).getByTestId("setting-scope").textContent?.includes("Atlas"),
    ) as HTMLElement;
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    // design §6: "0 means no cap" where it is true.
    expect(dialog).toHaveTextContent("0 means no budget: only the monthly cap limits it.");
    const input = within(dialog).getByTestId("setting-value");
    await user.clear(input);
    await user.type(input, "0");
    expect(within(dialog).queryByTestId("setting-value-problem")).toBeNull();
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({
      commands: [
        { name: "budget.set", params: { scope: "project", amountChf: 0, project: "proj_atlas" } },
      ],
      wordsUsed: "Settings: Project budget to no budget",
    });
  });

  it("no USD in Settings with Advanced open, the subscription allowance and fast mode included", async () => {
    // Review of later #43: the allowance read "the default (USD 50) is set low on purpose" and
    // "Now: CHF 40.00 a month (the default), stored as USD 50.00 at today's rate." Design §5
    // rule 7: CHF everywhere, never USD. Fast mode quoted the provider's price table until
    // W15-47; it now reads about CHF at the day's rate, so no part of the page is left out.
    const user = userEvent.setup();
    const harness = createHarness({
      setup: { credentials: { github: true, anthropicApiKey: true, subscription: true } },
    });
    // As the daemon: a fast-mode row for the project, with its price table.
    harness.daemon.state.fastMode = { proj_atlas: false };
    renderApp("/settings", harness);
    await screen.findAllByTestId("setting-row");
    await user.click(screen.getByTestId("settings-advanced-summary"));
    expect(screen.getByTestId("fast-mode-card")).toHaveTextContent("about CHF 6.40 / 32.00");
    const allowance = screen.getByTestId("plan-allowance-section");
    expect(await within(allowance).findByTestId("plan-allowance-current")).toHaveTextContent(
      /^Now: CHF 40\.00 a month \(the default\)\.$/,
    );
    expect(allowance).toHaveTextContent("the default is set low on purpose");
    await screen.findAllByTestId("model-settings-row");
    await within(screen.getByTestId("billing-order-section")).findAllByTestId(
      "billing-order-status",
    );
    const page = screen.getByRole("heading", { name: "Settings", level: 1 })
      .parentElement as HTMLElement;
    const usd = (page.textContent ?? "").match(/.{0,60}\bUSD\b.{0,40}/g) ?? [];
    expect(usd).toEqual([]);
  });
});

describe("setup opens on the step not done (later #28, P-welcome)", () => {
  const setupWith = (credentials: { github: boolean; anthropicApiKey: boolean }) => ({
    setup: {
      complete: false,
      showAssistant: false,
      name: "Robin",
      timezone: "Europe/Zurich",
      credentials: { ...credentials, subscription: false },
    },
  });
  const current = async () => {
    await waitFor(() =>
      expect(
        screen.getAllByRole("listitem").some((li) => li.getAttribute("aria-current") === "step"),
      ).toBe(true),
    );
    return screen
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("aria-current") === "step")
      ?.getAttribute("data-testid");
  };

  it("reopened after the Claude step was skipped, it opens the Claude step; no name to type again", async () => {
    // Before: Welcome, whose Continue needed the name typed again.
    renderApp("/setup", createHarness(setupWith({ github: true, anthropicApiKey: false })));
    await screen.findByTestId("setup-page");
    await waitFor(async () => expect(await current()).toBe("setup-step-Claude"));
    expect(screen.queryByTestId("setup-name")).toBeNull();
  });

  it("a refused key's 'Save a new key' (/setup) lands on the Claude step, though a key is saved", async () => {
    const harness = createHarness({
      ...setupWith({ github: true, anthropicApiKey: true }),
      billingOrder: { sources: [{ kind: "api_key", blocked: "refused" }] },
    } as Parameters<typeof createHarness>[0]);
    renderApp("/setup", harness);
    await screen.findByTestId("setup-page");
    await waitFor(async () => expect(await current()).toBe("setup-step-Claude"));
  });

  it("there, the Claude step says the saved key was refused, never '✓ An API key is saved.'", async () => {
    // Review of later #28: "Anthropic refused your API key" → "Save a new key" opened this step,
    // which said "✓ An API key is saved." above "Replace the API key".
    const harness = createHarness({
      ...setupWith({ github: true, anthropicApiKey: true }),
      billingOrder: { sources: [{ kind: "api_key", blocked: "refused" }] },
    } as Parameters<typeof createHarness>[0]);
    renderApp("/setup", harness);
    expect(await screen.findByTestId("setup-refused")).toHaveTextContent(
      "Anthropic refused the saved API key. Paste a new one below.",
    );
    expect(screen.queryByTestId("setup-saved")).toBeNull();
    // A new key that passes its check replaces it: the step then says it is saved.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Replace the API key"), "sk-ant-api03-new-key");
    await user.click(screen.getByTestId("setup-anthropic-check"));
    expect(await screen.findByTestId("setup-saved")).toHaveTextContent("An API key is saved.");
    expect(screen.queryByTestId("setup-refused")).toBeNull();
  });

  it("a fresh install still opens on Welcome", async () => {
    renderApp(
      "/setup",
      createHarness({
        setup: {
          ...setupWith({ github: false, anthropicApiKey: false }).setup,
          showAssistant: true,
        },
      }),
    );
    expect(await screen.findByTestId("setup-name")).toHaveValue("Robin");
  });
});

describe("the Overview's decisions and plan banner (later #79, #30)", () => {
  it("a decision reads as a short question with its answer when the answer names an option", async () => {
    // Before: "Where should the page be published: GitHub Pages, Netlify, or only as a local
    // file? Only as a local file for now; maybe GitHub Pages later."
    const harness = createHarness();
    const [first] = DECISIONS;
    if (!first) throw new Error("fixture changed");
    harness.client.decisions = async () => [
      {
        ...first,
        question:
          "Where should the page be published: GitHub Pages, Netlify, or only as a local file?",
        chosen: "Only as a local file for now; maybe GitHub Pages later.",
      },
    ];
    renderApp("/projects/proj_atlas/summary", harness);
    const rows = await within(await screen.findByTestId("decisions")).findAllByTestId("decision");
    expect(rows[0]).toHaveTextContent(
      /^Where should the page be published\? Only as a local file for now; maybe GitHub Pages later\. \(Alice, /,
    );
    // An answer that names none of the options keeps the whole question.
    expect(shortQuestion("Which host: A, B or C?", "Something else")).toBe(
      "Which host: A, B or C?",
    );
  });
});

describe("links land where they point (P7-12)", () => {
  it("/settings#other-settings, opened before the rows load, lands on Other settings", async () => {
    // Before: it scrolled once, at mount, before the rows were there (the section then moved
    // down as they loaded, and the page showed its top).
    const rowsAtScroll: number[] = [];
    const scrolled = vi.fn(() => {
      rowsAtScroll.push(document.querySelectorAll('[data-testid="setting-row"]').length);
    });
    const had = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      renderApp("/settings#other-settings");
      await screen.findAllByTestId("setting-row");
      await waitFor(() => expect(rowsAtScroll.some((n) => n > 0)).toBe(true));
      expect(document.getElementById("other-settings")).toHaveAttribute("data-targeted", "true");
      expect((screen.getByTestId("settings-advanced") as HTMLDetailsElement).open).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = had;
    }
  });

  it("a section above that loads after the rows: it lands again, at once; once the person scrolls, it stops", async () => {
    // Review of P7-12: it scrolled once, smoothly, as the rows came; the subscription allowance,
    // the credential order and the other sections above loaded afterwards and left "Other
    // settings" 400 to 1900 px down the page. The real geometry is in e2e/settings-links.spec.ts.
    // The credential order's rows (or its empty line) are there once it has loaded.
    const ORDER_LOADED = '[data-testid="billing-order-empty"], [data-testid^="billing-order-row-"]';
    const calls: { allowance: boolean; order: boolean; options: unknown }[] = [];
    const scrolled = vi.fn(function (this: Element, options?: unknown) {
      if (this.id !== "other-settings") return;
      calls.push({
        allowance: document.querySelector('[data-testid="plan-allowance-input"]') !== null,
        order: document.querySelector(ORDER_LOADED) !== null,
        options,
      });
    });
    const had = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      const harness = createHarness();
      // The allowance and the credential order answer only when the test lets them.
      let allowanceNow: () => void = () => {};
      const allowanceGate = new Promise<void>((r) => {
        allowanceNow = r;
      });
      const planAllowance = harness.client.planAllowance.bind(harness.client);
      harness.client.planAllowance = async (signal) => {
        await allowanceGate;
        return planAllowance(signal);
      };
      let orderNow: () => void = () => {};
      const orderGate = new Promise<void>((r) => {
        orderNow = r;
      });
      const billingOrder = harness.client.billingOrder.bind(harness.client);
      harness.client.billingOrder = async (signal) => {
        await orderGate;
        return billingOrder(signal);
      };
      renderApp("/settings#other-settings", harness);
      await screen.findAllByTestId("setting-row");
      await waitFor(() => expect(calls.length).toBeGreaterThan(0));
      expect(calls.every((c) => !c.allowance)).toBe(true);
      // The allowance loads above the target: the page lands again, without a smooth scroll.
      allowanceNow();
      await screen.findByTestId("plan-allowance-input");
      await waitFor(() => expect(calls.some((c) => c.allowance)).toBe(true));
      expect(calls.at(-1)?.options).toEqual({ block: "start", behavior: "instant" });
      expect(calls.some((c) => JSON.stringify(c.options).includes("smooth"))).toBe(false);
      // The person scrolls: the credential order that loads afterwards no longer moves the page.
      fireEvent.wheel(document.body, { deltaY: -400 });
      const before = calls.length;
      orderNow();
      await waitFor(() => expect(document.querySelector(ORDER_LOADED)).not.toBeNull());
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(before);
      expect(calls.some((c) => c.order)).toBe(false);
    } finally {
      Element.prototype.scrollIntoView = had;
    }
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

  it("Start session names the project its dialog starts: the one on screen, else the active one", async () => {
    // Review of later #61: opening Beacon from Home no longer makes it the active project, and
    // the palette still read "Start session: Atlas (the active project)" while its dialog
    // started Beacon, the project on screen.
    const user = userEvent.setup();
    const harness = createHarness();
    const draft = harness.daemon.state.tasks.find((t) => t.id === "task_4");
    if (!draft) throw new Error("fixture changed");
    draft.status = "ready";
    renderApp("/", harness);
    const cards = await screen.findAllByTestId("project-card");
    await user.click(within(cards[1] as HTMLElement).getByTestId("open-project"));
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Beacon");
    let p = await palette();
    await user.type(within(p).getByTestId("command-input"), "start session");
    const listed = within(p).getAllByTestId("command-item");
    expect(listed.map((i) => i.textContent ?? "")).toEqual([
      expect.stringContaining("Start session: Beacon"),
    ]);
    expect(listed[0]).toHaveTextContent("the project on screen");
    expect(p).not.toHaveTextContent("Atlas");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByTestId("start-session-dialog");
    await user.click(await within(dialog).findByTestId("confirm-start-session"));
    await waitFor(() => expect(postedCalls(harness, "/sessions")).toHaveLength(1));
    expect(postedCalls(harness, "/sessions")[0]?.body).toMatchObject({ projectId: "proj_beacon" });
    // Back on Home there is no project on screen: the entry names the active project.
    const [close] = within(dialog).getAllByRole("button", { name: "Close" });
    if (!close) throw new Error("the dialog has no Close");
    await user.click(close);
    await user.click(screen.getByRole("link", { name: "Home" }));
    await screen.findAllByTestId("project-card");
    p = await palette();
    await user.type(within(p).getByTestId("command-input"), "start session");
    const atHome = within(p).getAllByTestId("command-item");
    expect(atHome.map((i) => i.textContent ?? "")).toEqual([
      expect.stringContaining("Start session: Atlas"),
    ]);
    expect(atHome[0]).toHaveTextContent("the active project");
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
