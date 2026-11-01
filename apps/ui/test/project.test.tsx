import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { milestonesFromTasks } from "../src/pages/project/PlanTab.tsx";
import { money, PROJECTS, TASKS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Project page", () => {
  it("redirects to the summary tab, shows the tabs and the cached summary", async () => {
    renderApp("/projects/proj_atlas");
    const summary = await screen.findByTestId("summary");
    expect(summary).toHaveTextContent("Indexed the docs and opened a PR for the search box.");
    expect(summary).toHaveTextContent("Review PR #12");
    expect(summary).toHaveTextContent("1 open question");
    expect(screen.getByTestId("project-tabs")).toHaveTextContent(
      "SummaryPlanTasksDocsReviewsCostsDataChat",
    );
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
      // Design §3.3: "Planning failed: <reason in words>. [Try again]".
      expect(banner).toHaveTextContent("Planning failed. Nothing was written.");
      expect(within(banner).getByTestId("intake-error")).toHaveTextContent(FAILURE);
      expect(within(banner).getByTestId("intake-retry")).toHaveTextContent("Try again");
      await user.click(within(banner).getByTestId("intake-retry"));
      await waitFor(() =>
        expect(postedCalls(harness, "/projects/proj_beacon/intake/retry")).toHaveLength(1),
      );
      await waitFor(() =>
        expect(screen.getByTestId("intake-banner")).toHaveAttribute("data-state", "drafting"),
      );
      expect(screen.getByTestId("intake-banner")).toHaveTextContent(
        "Drafting the plan from your brief…",
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
      ["pending", /plan from your brief waits for your approval in the Inbox/],
      ["drafting", /plan from your brief is being drafted/],
      ["failed", /plan from your brief could not be drafted; the project page says why/],
    ] as const) {
      it(`the Start dialog names the plan as it stands: ${state}`, async () => {
        const user = userEvent.setup();
        const harness = createHarness();
        harness.daemon.state.intake.proj_beacon = intake(
          state,
          state === "failed" ? FAILURE : null,
        );
        renderApp("/projects/proj_beacon", harness);
        await screen.findByTestId("summary");
        await user.click(screen.getByTestId("start-session"));
        const dialog = await screen.findByTestId("start-session-dialog");
        expect(await within(dialog).findByTestId("start-session-intake")).toHaveTextContent(text);
      });
    }
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
    const warning = await within(dialog).findByTestId("start-session-cannot-run");
    expect(within(dialog).queryByTestId("start-session-no-work")).toBeNull();
    expect(within(warning).getByTestId("start-session-blocked")).toHaveTextContent(
      'Nothing can run: "Write the migration guide" waits on "Try the old approach", which was cancelled.',
    );
    expect(within(dialog).getByTestId("confirm-start-session")).toBeDisabled();
    expect(within(warning).getByTestId("start-session-waiting")).toHaveTextContent(
      '"Write the migration guide" waits on "Try the old approach" (cancelled): that will not be done by itself. Change what it waits for on the Tasks tab, or try the failed task again.',
    );
    expect(within(warning).getByTestId("start-session-over-budget")).toHaveTextContent(
      '"Decide the versioning scheme" needs about CHF 8.00, more than this session\'s work budget of CHF 4.00',
    );
    // The real default is filled in (design §3.6), not hidden behind "leave empty".
    const budget = within(dialog).getByLabelText(/Session budget/);
    expect(budget).toHaveValue("5.00");
    // A larger budget lets the large task in: the dialog says what runs; the stuck one is named.
    await user.clear(budget);
    await user.type(budget, "20");
    await waitFor(() =>
      expect(within(dialog).queryByTestId("start-session-cannot-run")).toBeNull(),
    );
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
      ["0", "The budget must be more than CHF 0."],
      ["-5", "The budget must be more than CHF 0."],
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
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    await waitFor(() =>
      expect(within(dialog).getByTestId("start-session-notice")).toHaveTextContent(
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
    expect(screen.queryByTestId("session-header")).not.toBeInTheDocument();
    await user.click(within(dialog).getByTestId("start-session-open"));
    const header = await screen.findByTestId("session-header");
    expect(header).toHaveTextContent(/Session sess_/);
    // The first event arrives over SSE after the session page mounts; CI runners have needed more than 4 s.
    await waitFor(() => expect(screen.getAllByTestId("event-row").length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
  });
});
