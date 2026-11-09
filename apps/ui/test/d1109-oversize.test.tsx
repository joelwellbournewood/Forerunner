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
    // CHF 6.00 at the fixtures' rate: more than the default session's work budget (CHF 4.00).
    big.estimate = money(7_500_000);
    const { user, dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-plan")).toHaveTextContent(
      /^This session works on "Build the shop" until its work budget is used\.$/,
    );
    expect(within(dialog).getByTestId("start-session-oversized")).toHaveTextContent(
      /^"Build the shop" needs about CHF 6\.00, more than this session's work budget of CHF 4\.00: it works until that budget is used, keeps its work, and asks you to continue\.$/,
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
    big.priority = "high";
    harness.daemon.state.tasks.push({
      ...big,
      id: "task_a",
      title: "A",
      // CHF 0.12.
      estimate: money(150_000),
      priority: "low",
    });
    const { dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-plan")).toHaveTextContent(
      /^This session runs "A" \(about CHF 0\.12\), then works on "Build the shop" with what is left\.$/,
    );
    // CHF 4.00 less 0.12: about CHF 3.88 for the larger task.
    expect(within(dialog).getByTestId("start-session-oversized")).toHaveTextContent(
      /^"Build the shop" needs about CHF 6\.00, more than this session's work budget of CHF 4\.00: after the other tasks it works with about CHF 3\.88, keeps its work, and asks you to continue\.$/,
    );
    expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled();
  });

  it("a second larger task is named once with why it waits; 'a larger budget, or the task a smaller one' appears nowhere", async () => {
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
      /^"Build the shop" needs about CHF 6\.00/,
    );
    const lines = within(note).getAllByTestId("start-session-over-budget");
    expect(lines.map((l) => l.textContent)).toEqual([
      '"Big two" needs about CHF 9.00, more than this session\'s work budget: one task that large runs a session, so it waits for the next one.',
    ]);
    expect(dialog).not.toHaveTextContent(/smaller one|smaller ones/);
    expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled();
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
