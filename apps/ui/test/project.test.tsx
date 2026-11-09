import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { EventSourceLike, StreamOptions } from "../src/api/sse.ts";
import { milestonesFromTasks } from "../src/pages/project/PlanTab.tsx";
import { money, PROJECTS, TASKS } from "./fixtures.ts";
import { createHarness, type Harness, postedCalls, renderApp } from "./helpers.tsx";

/** An `/events` EventSource wired to the fake daemon's listeners, open at once. */
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

describe("Project page", () => {
  it("opens on the Overview: the tabs are Overview, Tasks, Chat, Files and More; Last result, Next computed now, Your files (design §3.4, §6)", async () => {
    renderApp("/projects/proj_atlas");
    const summary = await screen.findByTestId("summary");
    expect(summary).toHaveTextContent("Indexed the docs and opened a PR for the search box.");
    // Next is the tasks as they are now, not the titles the last session captured.
    expect(within(summary).getByTestId("next")).toHaveTextContent(
      '"Add the search box to the header": Being reviewed',
    );
    expect(summary).not.toHaveTextContent("Review PR #12");
    // Atlas is linked to org/atlas: its files are the repository and the PRs that wait for
    // the person (ADR 0106), not this computer's copy of the default branch.
    const files = within(summary).getByTestId("your-files");
    expect(files).toHaveTextContent("On GitHub: org/atlas");
    expect(await within(files).findByTestId("pr-waiting")).toHaveTextContent(
      '"Index the documentation pages" · pull request #11',
    );
    const tabs = screen.getByTestId("project-tabs");
    const primary = within(tabs)
      .getAllByRole("link")
      .filter((l) => !l.closest("details"))
      .map((l) => l.textContent);
    expect(primary).toEqual(["Overview", "Tasks", "Chat", "Files"]);
    expect(
      within(screen.getByTestId("tab-more"))
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Plan", "Docs", "Reviews", "Costs", "Data"]);
    // The Overview's own cards: this project's open ones, each with Answer.
    expect(await screen.findAllByTestId("overview-card")).toHaveLength(2);
    expect(screen.getByTestId("read-aloud")).toBeEnabled();
    expect(screen.getByTestId("read-aloud")).toHaveTextContent("Read aloud");
  });

  it("Read aloud asks the daemon to speak the summary, shows the text being read, and Stop cancels it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("read-aloud"));
    // The daemon's voice provider reads it (spec A.6): the button posts to the speak route
    // and the echoed text is shown while it reads.
    const text = await screen.findByTestId("read-aloud-text");
    expect(text).toHaveTextContent("Atlas is in the build stage.");
    expect(text).toHaveTextContent("One question waits for you.");
    expect(postedCalls(harness, "/projects/proj_atlas/speak")).toHaveLength(1);
    expect(screen.getByTestId("read-aloud")).toHaveTextContent("Stop reading");
    expect(screen.getByTestId("read-aloud")).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByTestId("read-aloud"));
    await waitFor(() => expect(postedCalls(harness, "/speak/speak_1/cancel")).toHaveLength(1));
    expect(screen.queryByTestId("read-aloud-text")).not.toBeInTheDocument();
    expect(screen.getByTestId("read-aloud")).toHaveTextContent("Read aloud");
  });

  it("leaving the page while it reads stops the daemon too (nobody is left to hear it)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const view = renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("read-aloud"));
    await screen.findByTestId("read-aloud-text");
    expect(postedCalls(harness, "/speak/speak_1/cancel")).toHaveLength(0);
    view.unmount();
    await waitFor(() => expect(postedCalls(harness, "/speak/speak_1/cancel")).toHaveLength(1));
  });

  it("without a voice provider the button says why (jsdom has no browser speech either)", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ voiceUnavailable: true });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("read-aloud"));
    const notice = await screen.findByTestId("read-aloud-notice");
    expect(notice).toHaveTextContent("Voice unavailable: no TTS provider available");
    expect(screen.queryByTestId("read-aloud-text")).not.toBeInTheDocument();
    expect(screen.getByTestId("read-aloud")).toHaveTextContent("Read aloud");
  });

  it("derives milestones from the card and the tasks (the fallback without a milestones route)", () => {
    const rows = milestonesFromTasks(PROJECTS[0] as (typeof PROJECTS)[number], TASKS.slice(0, 3));
    expect(rows.map((r) => [r.id, r.tasks.length, r.done])).toEqual([
      ["ms_search", 2, 1],
      ["__none", 1, 0],
    ]);
  });

  it("shows costs by model, specialist and task with savings apart", async () => {
    renderApp("/projects/proj_atlas/costs");
    expect(await screen.findByTestId("cost-total")).toHaveTextContent("CHF 25.00");
    expect(screen.getByTestId("cost-by-model")).toHaveTextContent("Sonnet 5.5");
    expect(screen.getByTestId("cost-by-specialist")).toHaveTextContent("tester");
    expect(screen.getByTestId("cost-by-task")).toHaveTextContent(
      "Add the search box to the header",
    );
    expect(screen.getByTestId("cost-savings")).toHaveTextContent("Savings (not spend)");
    expect(screen.getByTestId("cost-savings")).toHaveTextContent("CHF 2.30");
    // The period in words (design §5), never "— → —" or an ISO time.
    expect(screen.getByTestId("cost-period")).toHaveTextContent(
      /^\d{1,2} (Sept?|Oct) to \d{1,2} Oct$/,
    );
  });

  it("fills every tab: docs, reviews and data are no longer placeholders", async () => {
    renderApp("/projects/proj_atlas/docs");
    expect(await screen.findByTestId("docs")).toBeInTheDocument();
    renderApp("/projects/proj_atlas/reviews");
    expect(await screen.findByTestId("reviews")).toBeInTheDocument();
    renderApp("/projects/proj_atlas/data");
    expect(await screen.findByTestId("data")).toBeInTheDocument();
    expect(screen.queryByTestId("placeholder")).not.toBeInTheDocument();
  });

  it("warns before a start that no task is ready and says how to give the agent work (U-009)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    // proj_beacon's only task is a draft: a session would plan nothing and end at once.
    renderApp("/projects/proj_beacon", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    const warning = await within(dialog).findByTestId("start-session-no-work");
    // Design §3.6: the reason in one sentence, the button that unblocks it, and Start refused.
    expect(warning).toHaveTextContent("Nothing can run: no task is ready.");
    expect(within(warning).getByTestId("start-session-unblock")).toHaveAttribute(
      "href",
      "/projects/proj_beacon/tasks",
    );
    expect(warning).toHaveTextContent(/Tasks tab/);
    expect(warning).toHaveTextContent(/add a task: write the README/);
    expect(within(dialog).getByTestId("confirm-start-session")).toBeDisabled();
    // U-046: no plan from a brief was asked for, so the dialog does not send the person to
    // the Inbox for one (it did, for every project).
    expect(warning).not.toHaveTextContent(/Inbox/);
  });

  it("while the agent is in another project's session, Start stays refused on a project with nothing to run; on the busy project it waits its turn (later #38)", async () => {
    // Before: any running session enabled Start ("Starts after the current session…") on a
    // project with nothing ready, and the queued start became a session that ran nothing.
    const user = userEvent.setup();
    const elsewhere = createHarness({ startOutcome: "queued", busyProjectId: "proj_atlas" });
    renderApp("/projects/proj_beacon", elsewhere);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    let dialog = await screen.findByTestId("start-session-dialog");
    expect(await within(dialog).findByTestId("start-session-no-work")).toHaveTextContent(
      "Nothing can run: no task is ready.",
    );
    expect(within(dialog).getByTestId("confirm-start-session")).toBeDisabled();
    expect(dialog).not.toHaveTextContent("Starts after the current session");
    cleanup();

    const here = createHarness({ startOutcome: "queued", busyProjectId: "proj_beacon" });
    renderApp("/projects/proj_beacon", here);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    dialog = await screen.findByTestId("start-session-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled());
    expect(dialog).toHaveTextContent("Starts after the current session");
    expect(within(dialog).queryByTestId("start-session-no-work")).not.toBeInTheDocument();
  });

  describe("the plan from the brief (U-046)", () => {
    const intake = (state: "drafting" | "pending" | "failed", error: string | null = null) => ({
      projectId: "proj_beacon",
      state,
      requestId: state === "pending" ? "req_intake" : null,
      outcome: null,
      appliedAt: null,
      docs: null,
      error,
    });
    const FAILURE = "The model's reply was not a plan: no JSON object in it.";

    it("a failed intake shows on the project page with what failed, and Retry drafts it again", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      harness.daemon.state.intake.proj_beacon = intake("failed", FAILURE);
      renderApp("/projects/proj_beacon", harness);
      const banner = await screen.findByTestId("intake-banner");
      expect(banner).toHaveAttribute("data-state", "failed");
      // Design §3.3: "Planning failed: <reason in words>. [Try again]", one line (wave 2: the
      // reason stood on a line of its own under "Planning failed. Nothing was written.").
      expect(within(banner).getByTestId("intake-error")).toHaveTextContent(
        /^Planning failed: the model's reply was not a plan: no JSON object in it\.$/,
      );
      expect(banner).not.toHaveTextContent("Nothing was written");
      expect(within(banner).getByTestId("intake-retry")).toHaveTextContent("Try again");
      await user.click(within(banner).getByTestId("intake-retry"));
      await waitFor(() =>
        expect(postedCalls(harness, "/projects/proj_beacon/intake/retry")).toHaveLength(1),
      );
      await waitFor(() =>
        expect(screen.getByTestId("intake-banner")).toHaveAttribute("data-state", "drafting"),
      );
      // later #30: and how long it usually takes.
      expect(screen.getByTestId("intake-banner")).toHaveTextContent(
        "Drafting the plan from your brief… This usually takes about a minute, then it waits in your Inbox for you to approve.",
      );
      // The daemon files the plan: the page follows without a reload.
      harness.daemon.state.intake.proj_beacon = intake("pending");
      await waitFor(
        () => expect(screen.getByTestId("intake-banner")).toHaveAttribute("data-state", "pending"),
        { timeout: 6000 },
      );
      expect(screen.getByTestId("intake-banner")).toHaveTextContent(
        "Waiting for you: approve the plan.",
      );
      expect(
        within(screen.getByTestId("intake-banner")).getByRole("link", { name: "Open" }),
      ).toHaveAttribute("href", "/inbox");
    }, 15_000);

    // Sibling of the review of fix/progress-navigation (bench, --provider none): the banner kept
    // "Try again", which the daemon refuses (503) while no Claude credential is in force.
    it("without Claude the failed plan's button is Connect Claude, not a Try again that is refused", async () => {
      const harness = createHarness({ me: { provider: null } });
      harness.daemon.state.intake.proj_beacon = intake(
        "failed",
        "Planning from the brief needs a Claude key or subscription. Add one in the app: Settings → Accounts and keys → Open the setup assistant, then retry.",
      );
      renderApp("/projects/proj_beacon", harness);
      const banner = await screen.findByTestId("intake-banner");
      expect(banner).toHaveAttribute("data-state", "failed");
      expect(within(banner).queryByTestId("intake-retry")).toBeNull();
      expect(within(banner).getByRole("link", { name: "Connect Claude" })).toHaveAttribute(
        "href",
        "/setup",
      );
    });

    it("a rejected plan says so, and Draft a new plan drafts one again from the brief (design §3.3)", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      harness.daemon.state.intake.proj_beacon = {
        ...intake("pending"),
        state: "rejected" as never,
        outcome: "rejected",
      };
      renderApp("/projects/proj_beacon", harness);
      const banner = await screen.findByTestId("intake-banner");
      expect(banner).toHaveAttribute("data-state", "rejected");
      expect(banner).toHaveTextContent("You rejected the plan. Nothing was written.");
      // No request id, no time stamp (design §5).
      expect(banner).not.toHaveTextContent(/req_|T\d\d:\d\d/);
      await user.click(within(banner).getByRole("button", { name: "Draft a new plan" }));
      await waitFor(() =>
        expect(postedCalls(harness, "/projects/proj_beacon/intake/retry")).toHaveLength(1),
      );
      await waitFor(() =>
        expect(screen.getByTestId("intake-banner")).toHaveAttribute("data-state", "drafting"),
      );
    });

    it("a project without an intake shows no banner", async () => {
      renderApp("/projects/proj_atlas");
      await screen.findByTestId("summary");
      expect(screen.queryByTestId("intake-banner")).toBeNull();
    });

    for (const [state, text] of [
      ["pending", /^Nothing can run yet: the plan from your brief waits for your approval\.$/],
      ["drafting", /^Nothing can run yet: the plan from your brief is being drafted\.$/],
    ] as const) {
      it(`the Start dialog names the plan as it stands in one sentence, said once: ${state} (wave 2 handoff)`, async () => {
        const user = userEvent.setup();
        const harness = createHarness();
        harness.daemon.state.intake.proj_beacon = intake(state, null);
        renderApp("/projects/proj_beacon", harness);
        await screen.findByTestId("summary");
        await user.click(screen.getByTestId("start-session"));
        const dialog = await screen.findByTestId("start-session-dialog");
        expect(await within(dialog).findByTestId("start-session-blocked")).toHaveTextContent(text);
        // Not again in other words, and not "add a task on the Tasks tab".
        expect(within(dialog).queryByTestId("start-session-intake")).toBeNull();
        expect(dialog).not.toHaveTextContent(/Give your agent work first/);
      });
    }

    it("the Start dialog names the plan as it stands: failed", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      harness.daemon.state.intake.proj_beacon = intake("failed", FAILURE);
      renderApp("/projects/proj_beacon", harness);
      await screen.findByTestId("summary");
      await user.click(screen.getByTestId("start-session"));
      const dialog = await screen.findByTestId("start-session-dialog");
      expect(await within(dialog).findByTestId("start-session-intake")).toHaveTextContent(
        /plan from your brief could not be drafted; the project page says why/,
      );
    });

    // U-078 (the review of credential-limits): planning that met a refused key waited, but the
    // page said "Planning failed: ... [Try again]", and Try again cannot work while the key is
    // refused; the card promised the work would start by itself, and nothing restarted it.
    const waiting = (reason: "refused" | "limit") => ({
      ...intake("failed"),
      state: "waiting" as const,
      error: null,
      wait:
        reason === "refused"
          ? {
              reason,
              kind: "api_key",
              until: null,
              text: "Planning waits for a new API key: save one in Settings.",
              short: "Planning waits for a new API key",
              save: { label: "Save a new key", to: "/setup" },
            }
          : {
              reason,
              kind: "api_key",
              until: "2026-11-03T15:40:00.000Z",
              text: "Planning waits until 16:40 (your API key's limit) and starts by itself.",
              short: "Planning waits until 16:40, your API key's limit",
              save: null,
            },
    });

    it("a plan that waits for a new key says so, links to where it is saved, and offers no Try again; saving it drafts the plan (U-078)", async () => {
      const harness = createHarness();
      harness.daemon.state.intake.proj_beacon = waiting("refused");
      renderApp("/projects/proj_beacon", harness, liveEvents(harness));
      const banner = await screen.findByTestId("intake-banner");
      expect(banner).toHaveAttribute("data-state", "waiting");
      expect(within(banner).getByTestId("intake-wait")).toHaveTextContent(
        /^Planning waits for a new API key: save one in Settings\.$/,
      );
      expect(banner).not.toHaveTextContent(/failed/i);
      expect(within(banner).queryByTestId("intake-retry")).toBeNull();
      expect(within(banner).getByRole("link", { name: "Save a new key" })).toHaveAttribute(
        "href",
        "/setup",
      );
      // The setup assistant saves a new key (as the daemon's `credentialSaved`): the plan is
      // drafted by itself, and the page follows without a reload.
      const saved = await harness.client.setupAnthropic("sk-ant-api03-new");
      expect(saved.ok).toBe(true);
      await waitFor(
        () => expect(screen.getByTestId("intake-banner")).toHaveAttribute("data-state", "drafting"),
        { timeout: 6000 },
      );
    }, 15_000);

    it("a plan that waits for a usage limit says until when and that it starts by itself, with no button (U-078)", async () => {
      const harness = createHarness();
      harness.daemon.state.intake.proj_beacon = waiting("limit");
      renderApp("/projects/proj_beacon", harness);
      const banner = await screen.findByTestId("intake-banner");
      expect(banner).toHaveAttribute("data-state", "waiting");
      expect(banner).toHaveTextContent(
        "Planning waits until 16:40 (your API key's limit) and starts by itself.",
      );
      expect(within(banner).queryByRole("button")).toBeNull();
      expect(within(banner).queryByRole("link")).toBeNull();
    });

    it("the Start dialog names a plan that waits for a new key, with where to save one (U-078)", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      harness.daemon.state.intake.proj_beacon = waiting("refused");
      renderApp("/projects/proj_beacon", harness);
      await screen.findByTestId("summary");
      await user.click(screen.getByTestId("start-session"));
      const dialog = await screen.findByTestId("start-session-dialog");
      expect(await within(dialog).findByTestId("start-session-blocked")).toHaveTextContent(
        /^Nothing can run yet\. Planning waits for a new API key: save one in Settings\.$/,
      );
      expect(within(dialog).getByTestId("start-session-unblock")).toHaveTextContent(
        "Save a new key",
      );
      expect(dialog).not.toHaveTextContent(/Give your agent work first|could not be drafted/);
    });

    // R-startcred (leftovers7-web): tasks are ready, but the only key is refused.
    it("with ready tasks whose only key is refused, the Start dialog says they wait for a new key, not what the session runs", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      harness.daemon.state.credentialWaitNow.proj_atlas = {
        text: "Waits for a new API key: save one in Settings.",
        save: { label: "Save a new key", to: "/setup" },
      };
      renderApp("/projects/proj_atlas", harness);
      await screen.findByTestId("summary");
      await user.click(screen.getByTestId("start-session"));
      const dialog = await screen.findByTestId("start-session-dialog");
      // W15-78: one sentence with a subject (before: "Nothing can run yet. Waits for a new API
      // key: save one in Settings.").
      expect(await within(dialog).findByTestId("start-session-blocked")).toHaveTextContent(
        /^Nothing can run until you save a new API key in Settings\.$/,
      );
      expect(within(dialog).getByTestId("start-session-unblock")).toHaveTextContent(
        "Save a new key",
      );
      // Before: 'This session runs "..." (about CHF ...)', and Start ended at once with the wait.
      expect(within(dialog).queryByTestId("start-session-plan")).toBeNull();
      expect(dialog).not.toHaveTextContent("This session runs");
    });
  });

  it("a task that only does not fit after the tasks before it is named as such, priced within its own budget (live walk 2, B3)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const tasks = harness.daemon.state.tasks;
    const ready = tasks.find((t) => t.id === "task_3");
    if (!ready) throw new Error("fixture changed");
    // The default session's work budget is CHF 4.00. Two tasks of about CHF 2.40 each: the
    // first runs, the second does not fit after it although it is smaller than the budget.
    ready.estimate = money(3_000_000);
    tasks.push({
      ...ready,
      id: "task_about",
      title: "About page",
      estimate: money(3_000_000),
      priority: "low",
    });
    // A task whose own budget (CHF 0.80) is below its estimate costs at most its budget.
    tasks.push({
      ...ready,
      id: "task_small",
      title: "Contact page",
      estimate: money(10_000_000),
      budget: money(1_000_000),
      priority: "low",
    });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    // later #48: "Contact page" is ready now ("and 1 more"), not one that becomes ready.
    expect(await within(dialog).findByTestId("start-session-plan")).toHaveTextContent(
      'This session runs "Decide the versioning scheme" (about CHF 2.40) and 1 more (about CHF 0.80).',
    );
    const left = within(dialog).getByTestId("start-session-over-budget");
    // C-45: only "Decide" runs before "About page"; "Contact page" runs after it.
    expect(left).toHaveTextContent(
      '"About page" (about CHF 2.40) may be left for next time: the tasks that run first take about CHF 2.40 of this session\'s work budget of CHF 4.00 (the budget less a fifth kept for reviews). Give the session a larger budget to be sure it runs.',
    );
    // Not the old sentence, which said 2.40 is more than 4.00.
    expect(left).not.toHaveTextContent("more than this session's work budget");
  });

  it("warns when ready tasks exist but none can run: what each waits on, what the budget leaves out (U-040)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const tasks = harness.daemon.state.tasks;
    const ready = tasks.find((t) => t.id === "task_3");
    if (!ready) throw new Error("fixture changed");
    // The one ready task of proj_atlas is larger than the default session's work budget.
    ready.estimate = money(10_000_000);
    tasks.push(
      { ...ready, id: "task_old", title: "Try the old approach", status: "cancelled" },
      {
        ...ready,
        id: "task_follow",
        title: "Write the migration guide",
        estimate: money(0),
        dependsOn: ["task_old"],
      },
    );
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    // d1109-oversize-start (D4): the task larger than the work budget runs anyway, with the
    // warning, so Start is on (before: "Nothing can run: ..." with Start off and the larger task
    // told to shrink). The stuck task is still named, in the same note.
    const warning = await within(dialog).findByTestId("start-session-oversized-note");
    expect(within(dialog).queryByTestId("start-session-cannot-run")).toBeNull();
    expect(within(dialog).queryByTestId("start-session-no-work")).toBeNull();
    expect(within(dialog).getByTestId("start-session-plan")).toHaveTextContent(
      'This session works on "Decide the versioning scheme" until its work budget is used.',
    );
    expect(within(warning).getByTestId("start-session-oversized")).toHaveTextContent(
      '"Decide the versioning scheme" needs about CHF 8.00, more than this session\'s work budget of CHF 4.00: it works until that budget is used, keeps its work, and asks you to continue.',
    );
    expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled();
    // later #69: the state in words, not "(cancelled)".
    expect(within(warning).getByTestId("start-session-waiting")).toHaveTextContent(
      '"Write the migration guide" waits on "Try the old approach", which was cancelled, so it cannot run. Change what it waits for on the Tasks tab.',
    );
    expect(within(warning).queryByTestId("start-session-over-budget")).toBeNull();
    // The real default is filled in (design §3.6), not hidden behind "leave empty".
    const budget = within(dialog).getByLabelText(/Session budget/);
    expect(budget).toHaveValue("5.00");
    // A larger budget lets the large task in: the dialog says what runs; the stuck one is named.
    await user.clear(budget);
    await user.type(budget, "20");
    await waitFor(() =>
      expect(within(dialog).queryByTestId("start-session-oversized-note")).toBeNull(),
    );
    expect(within(dialog).queryByTestId("start-session-cannot-run")).toBeNull();
    expect(within(dialog).getByTestId("start-session-plan")).toHaveTextContent(
      'This session runs "Decide the versioning scheme" (about CHF 8.00).',
    );
    const blockers = within(dialog).getByTestId("start-session-blockers");
    expect(blockers).toHaveTextContent(
      '"Write the migration guide" waits on "Try the old approach"',
    );
    expect(within(blockers).queryByTestId("start-session-over-budget")).toBeNull();
    // 0, a negative amount and more than is left this month are refused in words.
    for (const [typed, said] of [
      // W15B-16 (w15-words): CHF with its two decimals.
      ["0", "The budget must be more than CHF 0.00."],
      ["-5", "The budget must be more than CHF 0.00."],
      ["1000000", "That is more than what is left of your monthly cap (CHF 120.00)."],
    ] as const) {
      await user.clear(budget);
      await user.type(budget, typed);
      expect(within(dialog).getByTestId("start-session-budget-error")).toHaveTextContent(said);
      expect(within(dialog).getByTestId("confirm-start-session")).toBeDisabled();
    }
  });

  it("says a start is queued instead of opening a session that does not exist yet (U-003)", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ startOutcome: "queued" });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled());
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    expect(await within(dialog).findByTestId("start-session-notice")).toHaveTextContent(
      /Queued: your agent is in another session/,
    );
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-header")).not.toBeInTheDocument();
  });

  it("a second queued start says how many wait before it, since waiting starts run in order (U-043)", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ startOutcome: "queued" });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled());
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    expect(await within(dialog).findByTestId("start-session-notice")).toHaveTextContent(
      "Queued: your agent is in another session. This one starts when that one ends.",
    );
    // P7-16: after a start the dialog has no second Start; a second start opens it again.
    expect(within(dialog).queryByTestId("confirm-start-session")).toBeNull();
    await user.click(within(dialog).getByText("Close"));
    await user.click(screen.getByTestId("start-session"));
    const again = await screen.findByTestId("start-session-dialog");
    await waitFor(() => expect(within(again).getByTestId("confirm-start-session")).toBeEnabled());
    await user.click(within(again).getByTestId("confirm-start-session"));
    await waitFor(() =>
      expect(within(again).getByTestId("start-session-notice")).toHaveTextContent(
        "Queued: your agent is in another session, and 1 other start waits before this one; they run one after the other, in order. This one starts after them.",
      ),
    );
    expect(postedCalls(harness, "/sessions")).toHaveLength(2);
  });

  it("starts a session from the dialog, stays where it was, and the session can be opened from there (design §3.6)", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ eventDelayMs: 10 });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled());
    // proj_atlas has a ready task: no warning.
    expect(within(dialog).queryByTestId("start-session-no-work")).not.toBeInTheDocument();
    // It says what will run before anything starts.
    expect(within(dialog).getByTestId("start-session-plan")).toHaveTextContent(
      /^This session runs "Decide the versioning scheme"/,
    );
    const budget = within(dialog).getByLabelText(/Session budget/);
    await user.clear(budget);
    await user.type(budget, "4");
    await user.type(within(dialog).getByLabelText(/Note for this session/), "try the plan");
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    await waitFor(() => expect(postedCalls(harness, "/sessions")).toHaveLength(1));
    // The note travels as the session's note (it reaches every brief), the budget in USD.
    expect(postedCalls(harness, "/sessions")[0]?.body).toEqual({
      agentId: "agent_alice",
      projectId: "proj_atlas",
      trigger: "manual",
      budgetUsdMicro: 5_000_000,
      note: "try the plan",
    });
    // The person stays on the project page; the dialog says it started and links the session.
    expect(await within(dialog).findByTestId("start-session-notice")).toHaveTextContent(
      "Started: the session works until nothing more can run, the budget is used, or you stop it.",
    );
    // Said once: not also "Starts after the current session" about the session it just began.
    await waitFor(() => expect(within(dialog).queryByTestId("start-session-explain")).toBeNull());
    expect(dialog).not.toHaveTextContent("Starts after the current session");
    expect(screen.queryByTestId("session-header")).not.toBeInTheDocument();
    await user.click(within(dialog).getByTestId("start-session-open"));
    const header = await screen.findByTestId("session-header");
    // Design §3.7: named by its project and when it began, never its id.
    expect(header).toHaveTextContent(/Atlas · session at /);
    expect(header).not.toHaveTextContent(/sess_/);
    // The first event arrives over SSE after the session page mounts; CI runners have needed more than 4 s.
    await waitFor(() => expect(screen.getAllByTestId("event-row").length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
  });
});

/**
 * leftovers7-tailrun, wave 13 (TR-2): looking at the Start check records nothing, so a reset no
 * Start kept a wait for says what Start does, and Start stays pressable: its session keeps the
 * wait and the work starts by itself at the reset.
 */
describe("leftovers7-tailrun, wave 13: Start keeps a credential wait, looking does not (TR-2)", () => {
  it("the dialog says what Start does and Start sends the start", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.credentialWaitNow.proj_atlas = {
      // W15-65: the daemon's words (before: "... Press Start and it runs then.").
      text: "Nothing can run until 09:30 (your API key's limit). Press Start and the work starts then.",
      save: null,
      startable: true,
    };
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    expect(await within(dialog).findByTestId("start-session-blocked")).toHaveTextContent(
      /^Nothing can run until 09:30 \(your API key's limit\)\. Press Start and the work starts then\.$/,
    );
    expect(within(dialog).queryByTestId("start-session-plan")).toBeNull();
    // Before: Start was off whenever the check named a wait, so nothing kept it and the work
    // never started by itself.
    const start = within(dialog).getByTestId("confirm-start-session");
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(postedCalls(harness, "/sessions")).toHaveLength(1));
    expect(postedCalls(harness, "/sessions")[0]?.body).toMatchObject({
      projectId: "proj_atlas",
      trigger: "manual",
    });
  });

  it("a wait already kept says the work starts by itself, and Start stays off", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.credentialWaitNow.proj_atlas = {
      text: "Waits until 09:30 (your API key's limit) and starts by itself.",
      save: null,
    };
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    // W15-78: one sentence with a subject (before: "Nothing can run yet. Waits until 09:30 ...
    // and starts by itself.").
    expect(await within(dialog).findByTestId("start-session-blocked")).toHaveTextContent(
      /^Nothing can run until 09:30 \(your API key's limit\); it starts by itself then\.$/,
    );
    expect(within(dialog).getByTestId("confirm-start-session")).toBeDisabled();
  });
});

/**
 * leftovers7-tailrun, wave 13 (TR-12): while the agent drafts a plan (a New project's brief),
 * the Start dialog said "This session runs ..." as if it started at once (the check's `busy` did
 * not count the planning call's hold), and after Start "Queued: your agent is in another
 * session", while the person sees "Drafting the plan", not a session.
 */
describe("leftovers7-tailrun, wave 13: Start while a plan is drafted (TR-12)", () => {
  it("the dialog says the plan is being drafted, and after Start that this one starts when it is ready", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ startOutcome: "queued", agentPlanning: true });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    expect(await within(dialog).findByTestId("start-session-plan")).toHaveTextContent(
      // W15-39 (w15-words): the plan, not "it" (before: "starts once it is ready").
      /^Your agent is drafting a plan; this session starts once the plan is ready\.$/,
    );
    // Before: 'This session runs "..." (about CHF ...)' and "Starts after the current session".
    expect(dialog).not.toHaveTextContent("This session runs");
    expect(dialog).not.toHaveTextContent("Starts after the current session");
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    expect(await within(dialog).findByTestId("start-session-notice")).toHaveTextContent(
      "Queued: your agent is drafting a plan. This one starts when the plan is ready.",
    );
    expect(dialog).not.toHaveTextContent("your agent is in another session");
  });
});

/**
 * w15-tail, wave 15 run B (W15B-02): a removed project (its creation undone) still offered Start
 * session and Create a repository on its page (from an old notification or a bookmark), and the
 * start went through and spent.
 */
describe("w15-tail, wave 15 run B: a removed project's page (W15B-02)", () => {
  it("says the project was removed and offers no Start session, no Create a repository and no status button; a start sent anyway is refused in one sentence", async () => {
    const harness = createHarness();
    const beacon = harness.daemon.state.projects.find((p) => p.id === "proj_beacon");
    if (!beacon) throw new Error("no proj_beacon fixture");
    // As GET /projects/:id answers it after the creation's Undo (W15-36).
    beacon.status = "archived";
    beacon.name = "Beacon (removed)";
    renderApp("/projects/proj_beacon", harness);
    expect(await screen.findByTestId("project-removed")).toHaveTextContent(
      /^This project was removed\.$/,
    );
    const header = screen.getByTestId("project-header");
    expect(within(header).queryByTestId("start-session")).toBeNull();
    expect(within(header).queryByTestId("create-repo")).toBeNull();
    expect(within(header).queryByTestId("project-status")).toBeNull();
    expect(within(header).queryByRole("button")).toBeNull();
    // What the daemon answers a start on it from any client (the fake as the real one).
    await expect(
      harness.client.startSession({ agentId: "agent_alice", projectId: "proj_beacon" }),
    ).rejects.toThrow('The project "Beacon" was removed, so nothing of it runs.');
  });
});
