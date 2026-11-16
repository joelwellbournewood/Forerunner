import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { money } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * d1109-oversize-start (OS-4; the owner's D4 of 2026-11-09: "it should get a warning, but it
 * should get done anyway"). Before, a ready task whose estimate alone was more than the
 * session's work budget turned the Start dialog off ("Nothing can run within this budget: ...")
 * and told the person to give the session a larger budget or the task a smaller one; beside
 * other work it was left out of every session of that size. Now Start stays on, the plan
 * sentence names the larger task and the amber note gives the daemon's warning.
 */
describe("d1109-oversize-start, run C: the Start dialog warns and starts a task larger than the work budget (OS-4)", () => {
  const readyTask = (harness: ReturnType<typeof createHarness>) => {
    const t = harness.daemon.state.tasks.find((x) => x.id === "task_3");
    if (!t) throw new Error("fixture changed");
    return t;
  };
  const openDialog = async (harness: ReturnType<typeof createHarness>) => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    return { user, dialog: await screen.findByTestId("start-session-dialog") };
  };

  it("the only ready task is larger: the plan sentence, the daemon's warning, Start on, and the POST sends the typed budget", async () => {
    const harness = createHarness();
    const big = readyTask(harness);
    big.title = "Build the shop";
    // CHF 6.00 at the fixtures' rate, CHF 6.07 with its review part (d1116-budget-all, BA-10):
    // more than the default session's work budget (CHF 4.00).
    big.estimate = money(7_500_000);
    const { user, dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-plan")).toHaveTextContent(
      /^This session works on "Build the shop" until its work budget is used\.$/,
    );
    expect(within(dialog).getByTestId("start-session-oversized")).toHaveTextContent(
      /^"Build the shop" needs about CHF 6\.07, more than this session's work budget of CHF 4\.00: it works until that budget is used, keeps its work, and asks you to continue\.$/,
    );
    expect(within(dialog).queryByTestId("start-session-cannot-run")).toBeNull();
    expect(dialog).not.toHaveTextContent(
      "Give the session a larger budget, or the task a smaller one.",
    );
    expect(dialog).not.toHaveTextContent("Nothing can run");
    // A smaller budget: the warning follows the typed amount; Start stays on and sends it.
    const budget = within(dialog).getByLabelText(/Session budget/);
    await user.clear(budget);
    await user.type(budget, "2.00");
    await waitFor(() =>
      expect(within(dialog).getByTestId("start-session-oversized")).toHaveTextContent(
        "more than this session's work budget of CHF 1.60: it works until that budget is used",
      ),
    );
    const start = within(dialog).getByTestId("confirm-start-session");
    expect(start).toBeEnabled();
    await user.click(start);
    expect(await within(dialog).findByTestId("start-session-notice")).toHaveTextContent(
      /^Started: /,
    );
    const [sent] = postedCalls(harness, "/sessions");
    expect(sent?.body).toMatchObject({
      projectId: "proj_atlas",
      trigger: "manual",
      budgetUsdMicro: 2_500_000,
    });
  });

  it("with a task that fits first: it runs first, then the larger task works with what is left", async () => {
    const harness = createHarness();
    const big = readyTask(harness);
    big.title = "Build the shop";
    big.estimate = money(7_500_000);
    // d1109-oversize-pause (OP-0): "first" is the plan's order (priority first); before, the
    // larger task at "high" still came after the task that fits.
    big.priority = "low";
    harness.daemon.state.tasks.push({
      ...big,
      id: "task_a",
      title: "A",
      // CHF 0.12, CHF 0.19 with its review part (d1116-budget-all, BA-10).
      estimate: money(150_000),
      priority: "high",
    });
    const { dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-plan")).toHaveTextContent(
      /^This session runs "A" \(about CHF 0\.19\), then works on "Build the shop" with what is left\.$/,
    );
    // CHF 4.00 less 0.19: about CHF 3.81 for the larger task (before: 0.12 and 3.88).
    expect(within(dialog).getByTestId("start-session-oversized")).toHaveTextContent(
      /^"Build the shop" needs about CHF 6\.07, more than this session's work budget of CHF 4\.00: after "A" it works with about CHF 3\.81, keeps its work, and asks you to continue\.$/,
    );
    expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled();
  });

  it("a second larger task is named once after the first; 'a larger budget, or the task a smaller one' appears nowhere", async () => {
    const harness = createHarness();
    const big = readyTask(harness);
    big.title = "Build the shop";
    big.estimate = money(7_500_000);
    big.priority = "high";
    harness.daemon.state.tasks.push({
      ...big,
      id: "task_big2",
      title: "Big two",
      estimate: money(11_250_000),
      priority: "low",
    });
    const { dialog } = await openDialog(harness);
    const note = await within(dialog).findByTestId("start-session-oversized-note");
    expect(within(note).getByTestId("start-session-oversized")).toHaveTextContent(
      /^"Build the shop" needs about CHF 6\.07/,
    );
    // d1109-oversize-pause (OP-0): it comes after the first (before: 'one task that large runs a
    // session, so it waits for the next one.').
    expect(within(note).getByTestId("start-session-comes-after")).toHaveTextContent(
      /^"Big two" comes after it: it runs if "Build the shop" leaves budget, else in your next session\.$/,
    );
    expect(within(note).queryAllByTestId("start-session-over-budget")).toHaveLength(0);
    expect(dialog).not.toHaveTextContent(/smaller one|smaller ones/);
    expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled();
  });

  it("OS-5: the plan card says under a task larger than a session's work budget that it pauses with its work kept; a task that fits says nothing", async () => {
    const harness = createHarness();
    harness.daemon.state.requests.unshift({
      id: "req_intake_shop",
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId: null,
      taskTitle: null,
      sessionId: null,
      kind: "approval",
      why: 'Intake for "Atlas": 2 tasks and a first-session plan.',
      steps: [],
      options: ["approve", "reject"],
      blocking: true,
      risk: "medium",
      changeCard: {
        key: "intake:proj_atlas",
        project_id: "proj_atlas",
        docs_target: "workspace",
        cost_usd_micro: 0,
        applied_at: null,
        proposal: {
          plan: {
            reason: "planned from the brief",
            milestones: [],
            tasks: [
              {
                key: "shop",
                title: "Build the shop",
                outcome: "shop.html",
                acceptanceCriteria: [],
                priority: "high",
                dependsOn: [],
                specialist: "coder",
              },
              {
                key: "about",
                title: "Write the about page",
                outcome: "about.html",
                acceptanceCriteria: [],
                priority: "medium",
                dependsOn: [],
                specialist: "coder",
              },
            ],
          },
          docs: { "README.md": "# Atlas\n" },
          firstSession: {
            summary: "The shop first.",
            items: [
              // USD 7.50 (CHF 6.00): more than the default session's work budget (CHF 4.00).
              { key: "shop", estimateUsdMicro: 7_500_000 },
              { key: "about", estimateUsdMicro: 150_000 },
            ],
          },
        },
      },
      status: "open",
      answer: null,
      createdAt: "2026-10-19T22:00:00.000Z",
      version: 1,
    });
    renderApp("/inbox", harness);
    const card = await screen.findByTestId("intake-card");
    await waitFor(() => expect(within(card).getAllByTestId("intake-task")).toHaveLength(2));
    const notes = within(card)
      .getAllByTestId("intake-task")
      .map((t) => within(t).queryByTestId("intake-task-oversized")?.textContent ?? null);
    expect(notes).toEqual([
      "More than a session's work budget (CHF 4.00): it pauses with its work kept and asks you to continue.",
      null,
    ]);
  });

  it("OS-6: the chat's Yes/No card for 'start a session' reads the warning; Yes starts the session", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const big = readyTask(harness);
    big.title = "Build the shop";
    big.estimate = money(7_500_000);
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "start a session");
    await user.click(screen.getByTestId("chat-send"));
    const confirmation = await screen.findByTestId("pending-confirmation");
    expect(confirmation).toHaveTextContent(
      '"Build the shop" needs more than its work budget of CHF 4.00: it pauses with its work kept and asks you to continue.',
    );
    expect(confirmation).not.toHaveTextContent("Nothing can run");
    const before = harness.daemon.state.sessions.length;
    await user.click(within(confirmation).getByTestId("confirm-yes"));
    await waitFor(() => expect(harness.daemon.state.sessions.length).toBe(before + 1));
  });

  // Sibling (validation rule 8): "Continue where it stopped" read "no task fits" as nothing to
  // run (`!check.runnable.length`), so the project Stop all stopped got no session back when its
  // only ready task was larger than the work budget.
  it("Continue where it stopped starts again a project whose only ready task is larger than the work budget", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const big = readyTask(harness);
    big.title = "Build the shop";
    big.estimate = money(7_500_000);
    const base = harness.daemon.state.sessions[0];
    if (!base) throw new Error("fixture changed");
    harness.daemon.state.sessions.push({
      ...base,
      id: "sess_live",
      status: "running",
      endedAt: null,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    renderApp("/", harness, { pollIntervalMs: 40 });
    await user.click(await screen.findByTestId("kill-switch"));
    await user.click(await screen.findByTestId("kill-confirm-stop"));
    const bar = await screen.findByTestId("kill-banner");
    await user.click(within(bar).getByTestId("kill-continue"));
    await waitFor(() => expect(postedCalls(harness, "/sessions")).toHaveLength(1));
    expect(postedCalls(harness, "/sessions")[0]?.body).toMatchObject({
      projectId: "proj_atlas",
      trigger: "manual",
    });
  });
});

/**
 * d1109-oversize-pause (OP-0; the owner's answer 5 of 2026-11-09: "it should work on tasks even
 * when it cannot complete them, and be able to wrap up and continue next time"): the larger task
 * at its place in the plan's order. The Start dialog and chat's read-back name the tasks before it
 * and after it; nothing says "after the other tasks" or "one task that large runs a session".
 */
describe("d1109-oversize-pause, run C: the Start dialog and chat say the plan's order (OP-0)", () => {
  const readyTask = (harness: ReturnType<typeof createHarness>) => {
    const t = harness.daemon.state.tasks.find((x) => x.id === "task_3");
    if (!t) throw new Error("fixture changed");
    return t;
  };
  /** "Build the shop" (CHF 6.00) at the highest priority and "Write the notes" (CHF 0.24) after it. */
  const withBigFirst = (harness: ReturnType<typeof createHarness>) => {
    const big = readyTask(harness);
    big.title = "Build the shop";
    big.estimate = money(7_500_000);
    big.priority = "high";
    harness.daemon.state.tasks.push({
      ...big,
      id: "task_notes",
      title: "Write the notes",
      estimate: money(300_000),
      priority: "low",
    });
  };

  it("the larger task first: the plan sentence and the amber note name the task after it, and Start sends the budget", async () => {
    const harness = createHarness();
    withBigFirst(harness);
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    expect(await within(dialog).findByTestId("start-session-plan")).toHaveTextContent(
      /^This session works on "Build the shop" until its work budget is used; "Write the notes" runs after it only if budget is left\.$/,
    );
    const note = within(dialog).getByTestId("start-session-oversized-note");
    expect(within(note).getByTestId("start-session-oversized")).toHaveTextContent(
      /^"Build the shop" needs about CHF 6\.07, more than this session's work budget of CHF 4\.00: it works until that budget is used, keeps its work, and asks you to continue\.$/,
    );
    expect(within(note).getByTestId("start-session-comes-after")).toHaveTextContent(
      /^"Write the notes" comes after it: it runs if "Build the shop" leaves budget, else in your next session\.$/,
    );
    expect(dialog).not.toHaveTextContent(/after the other tasks|one task that large|may be left/);
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    const [sent] = postedCalls(harness, "/sessions");
    expect(sent?.body).toMatchObject({ projectId: "proj_atlas", trigger: "manual" });
  });

  it("continue next time: a plain Start takes a task paused at the session's budget and its card moves to Answered with the Done line; one paused at its own budget stays", async () => {
    const harness = createHarness();
    const shop = readyTask(harness);
    shop.title = "Build the shop";
    shop.status = "needs_human";
    shop.estimate = money(1_000_000);
    const own = { ...shop, id: "task_own", title: "Own budget task" };
    harness.daemon.state.tasks.push(own);
    const pauseCard = (id: string, taskId: string, title: string, source: string) => ({
      id,
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId,
      taskTitle: title,
      sessionId: "sess_1",
      kind: "approval",
      why: `"${title}" paused before its budget ran out.`,
      steps: [],
      options: ["Continue (CHF 0.80 more)", "Cancel task"],
      blocking: true,
      risk: "medium" as const,
      changeCard: {
        key: "task:budget_stop",
        task_id: taskId,
        task_title: title,
        title: `"${title}" paused before its budget ran out`,
        run_id: "run_1",
        source,
        specialist: "coder",
        cap_usd_micro: 1_000_000,
        spent_usd_micro: 300_000,
        continue_usd_micro: 1_000_000,
        stopped_by: "wrap_up",
        done: "Half of it.",
        left: ["The rest"],
        no_progress: false,
        chf_per_usd: 0.8,
        applied_at: null,
      },
      status: "open",
      answer: null,
      createdAt: "2026-11-10T09:00:00.000Z",
      version: 1,
    });
    harness.daemon.state.requests.unshift(
      pauseCard("req_next", shop.id, "Build the shop", "session"),
      pauseCard("req_own", own.id, "Own budget task", "task_budget"),
    );
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    expect(await within(dialog).findByTestId("start-session-plan")).toHaveTextContent(
      "Build the shop",
    );
    expect(within(dialog).getByTestId("start-session-plan")).not.toHaveTextContent(
      "Own budget task",
    );
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    await waitFor(() => expect(postedCalls(harness, "/sessions")).toHaveLength(1));
    // The Inbox, as the daemon answers it (real-daemon.test.ts 'OP-0 continue next time').
    renderApp("/inbox", harness);
    await user.click(await screen.findByText(/^Answered \(\d+\)$/));
    const entry = (await screen.findAllByTestId("answered-request")).find(
      (e) => e.getAttribute("data-request-id") === "req_next",
    ) as HTMLElement;
    expect(entry).toHaveTextContent(/Your session of \d\d:\d\d went on with it\.$/);
    expect(harness.daemon.state.tasks.find((t) => t.id === shop.id)?.status).toBe("ready");
    expect(harness.daemon.state.requests.find((r) => r.id === "req_own")?.status).toBe("open");
    expect(harness.daemon.state.tasks.find((t) => t.id === own.id)?.status).toBe("needs_human");
  });

  it("chat's read-back for 'start a session' says the warning, then the task after it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    withBigFirst(harness);
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "start a session");
    await user.click(screen.getByTestId("chat-send"));
    const confirmation = await screen.findByTestId("pending-confirmation");
    expect(confirmation).toHaveTextContent(
      '"Build the shop" needs more than its work budget of CHF 4.00: it pauses with its work kept and asks you to continue. "Write the notes" comes after it: it runs if "Build the shop" leaves budget, else in your next session.',
    );
  });
});
