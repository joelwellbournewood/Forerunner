import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * d1109-cred-screens (run C, C6), CS-3 (ADR 0120 amended 2026-11-16; the owner's 7a: "use
 * subscription until runs out --> go to API after asking human"): the Start dialog says what
 * happens if the first choice runs out, and with it out under 'ask' or 'wait' it lets the person
 * choose: "Use API key" or "Start at 15:40", the preset's lean first. The words are the daemon's
 * (`StartCheckView.credential`); each case clicks what a person clicks and reads what is sent.
 */
const USE = {
  label: "Use API key",
  explain:
    "Runs now on your API key until 15:40, about CHF 0.90; nothing passes this session's budget.",
};
const LATER = {
  label: "Start at 15:40",
  explain: "Runs on your subscription once it is back; nothing moves before.",
};

async function openDialog(harness: ReturnType<typeof createHarness>) {
  const user = userEvent.setup();
  renderApp("/projects/proj_atlas", harness);
  await screen.findByTestId("summary");
  await user.click(screen.getByTestId("start-session"));
  return { user, dialog: await screen.findByTestId("start-session-dialog") };
}

describe("d1109-cred-screens, run C: the Start dialog's credential line and buttons (CS-3)", () => {
  it("one line under the plan sentence of what happens if the first choice runs out", async () => {
    const harness = createHarness();
    harness.daemon.state.startCredential.proj_atlas = {
      line: "If your subscription runs out, you are asked before your API key is used.",
      runOut: null,
    };
    const { dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-credential")).toHaveTextContent(
      "If your subscription runs out, you are asked before your API key is used.",
    );
    expect(within(dialog).getByTestId("start-session-plan")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("start-session-run-out")).toBeNull();
  });

  it("under 'ask' with the subscription out: Use API key first, then Start at 15:40; Use API key sends the one-off flag", async () => {
    const harness = createHarness();
    harness.daemon.state.credentialWaitNow.proj_atlas = {
      text: "Nothing can run until 15:40 (your subscription's limit). Press Start at 15:40 and the work starts then.",
      save: null,
      startable: true,
    };
    harness.daemon.state.startCredential.proj_atlas = {
      line: null,
      runOut: {
        use: USE,
        later: LATER,
        lean: "use",
        goesOnLine: null,
        stoppedLine: "Your subscription is at its limit until 15:40.",
      },
    };
    const { user, dialog } = await openDialog(harness);
    const list = await within(dialog).findByTestId("start-session-run-out");
    const buttons = within(list)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(buttons).toEqual(["Use API key", "Start at 15:40"]);
    // The line above the two buttons says the stop: "Nothing can run until 15:40" is not true
    // when Use API key runs now; no "Start: works until ..." line for a Start that is not there.
    expect(within(dialog).getByTestId("start-session-blocked")).toHaveTextContent(
      /^Your subscription is at its limit until 15:40\.$/,
    );
    expect(within(dialog).queryByTestId("start-session-explain")).toBeNull();
    expect(list).toHaveTextContent(USE.explain);
    expect(list).toHaveTextContent(LATER.explain);
    // No third Start beside the two.
    expect(within(dialog).queryByTestId("confirm-start-session")).toBeNull();
    await user.click(within(list).getByTestId("start-session-use-key"));
    await within(dialog).findByTestId("start-session-notice");
    const sent = postedCalls(harness, "/sessions").map((c) => c.body as Record<string, unknown>);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ projectId: "proj_atlas", useOtherCredential: true });
    expect(harness.daemon.state.credentialGrants).toEqual(["proj_atlas"]);
  });

  it("under 'wait': Start at 15:40 first; it sends a plain start, kept for the reset", async () => {
    const harness = createHarness();
    harness.daemon.state.credentialWaitNow.proj_atlas = {
      text: "Nothing can run until 15:40 (your subscription's limit). Press Start at 15:40 and the work starts then.",
      save: null,
      startable: true,
    };
    harness.daemon.state.startCredential.proj_atlas = {
      line: null,
      runOut: {
        use: USE,
        later: LATER,
        lean: "later",
        goesOnLine: null,
        stoppedLine: "Your subscription is at its limit until 15:40.",
      },
    };
    const { user, dialog } = await openDialog(harness);
    const list = await within(dialog).findByTestId("start-session-run-out");
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Start at 15:40", "Use API key"]);
    // C3-left-9 (intent kept: the sentence matches the buttons beside it): with two buttons, the
    // stop alone; each button says what it does.
    expect(within(dialog).getByTestId("start-session-blocked")).toHaveTextContent(
      /^Your subscription is at its limit until 15:40\.$/,
    );
    await user.click(within(list).getByTestId("start-session-later"));
    expect(await within(dialog).findByTestId("start-session-notice")).toHaveTextContent(
      "starts at 15:40",
    );
    const sent = postedCalls(harness, "/sessions").map((c) => c.body as Record<string, unknown>);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.useOtherCredential).toBeUndefined();
  });

  it("the project's own session already waits to go on: its line in place of Start at, and Use API key alone", async () => {
    const harness = createHarness();
    harness.daemon.state.credentialWaitNow.proj_atlas = {
      text: "Waits until 15:40 (your subscription's limit); then your session goes on.",
      save: null,
      kept: true,
    };
    harness.daemon.state.startCredential.proj_atlas = {
      line: null,
      runOut: {
        use: USE,
        later: null,
        lean: "use",
        goesOnLine: "Your session of 14:05 goes on by itself at 15:40.",
      },
    };
    const { dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-blocked")).toHaveTextContent(
      "Your session of 14:05 goes on by itself at 15:40.",
    );
    const list = within(dialog).getByTestId("start-session-run-out");
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Use API key"]);
    expect(within(dialog).queryByTestId("confirm-start-session")).toBeNull();
    expect(within(dialog).queryByText("Start at 15:40")).toBeNull();
  });

  it("with a yes standing: one line and the usual Start, no buttons", async () => {
    const harness = createHarness();
    harness.daemon.state.startCredential.proj_atlas = {
      line: "You said yes to your API key until 15:40, so this runs on it (about CHF 0.90).",
      runOut: null,
    };
    const { dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-credential")).toHaveTextContent(
      "You said yes to your API key until 15:40, so this runs on it (about CHF 0.90).",
    );
    await waitFor(() =>
      expect(within(dialog).getByTestId("confirm-start-session")).toHaveTextContent("Start"),
    );
    expect(within(dialog).queryByTestId("start-session-run-out")).toBeNull();
  });

  // The review of the fix-up: with nothing to run the dialog offered "Use API key" ("about CHF
  // 0.00"), and pressing it wrote the person's yes before the start was refused.
  const STOPPED = {
    line: null,
    runOut: {
      use: USE,
      later: LATER,
      lean: "use" as const,
      goesOnLine: null,
      stoppedLine: "Your subscription is at its limit until 15:40.",
    },
  };

  it("nothing to run: no Use API key, only the start's own sentence, and no yes", async () => {
    const harness = createHarness();
    for (const t of harness.daemon.state.tasks)
      if (t.projectId === "proj_atlas" && t.status === "ready") t.status = "draft";
    harness.daemon.state.startCredential.proj_atlas = STOPPED;
    const { dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-blocked")).toHaveTextContent(
      /^Nothing can run/,
    );
    expect(within(dialog).queryByTestId("start-session-run-out")).toBeNull();
    expect(within(dialog).queryByText("Use API key")).toBeNull();
    expect(within(dialog).getByTestId("confirm-start-session")).toBeDisabled();
    expect(postedCalls(harness, "/sessions")).toHaveLength(0);
    expect(harness.daemon.state.credentialGrants).toEqual([]);
  });

  it("Stop all: no Use API key, only the Stop all sentence", async () => {
    const harness = createHarness();
    harness.daemon.state.killActive = true;
    harness.daemon.state.startCredential.proj_atlas = STOPPED;
    const { dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-blocked")).toHaveTextContent(
      "Sessions are stopped (Stop all), so nothing can start.",
    );
    expect(within(dialog).queryByTestId("start-session-run-out")).toBeNull();
    expect(within(dialog).queryByText("Use API key")).toBeNull();
    expect(harness.daemon.state.credentialGrants).toEqual([]);
  });
});

describe("d1109-cred-screens, run C: the plan card's foot line (CS-4)", () => {
  it("shows the daemon's line once at the card's foot, under the total", async () => {
    const harness = createHarness();
    harness.daemon.state.planCredentialLine =
      "Your subscription is at its limit until 15:40: you are asked before your API key is used.";
    harness.daemon.state.requests.unshift({
      id: "req_intake",
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId: null,
      sessionId: "sess_9",
      kind: "approval",
      why: 'Plan for "Atlas"',
      steps: [],
      options: ["approve", "reject"],
      blocking: true,
      risk: "medium",
      changeCard: {
        key: "intake:proj_atlas",
        project_id: "proj_atlas",
        docs_target: "repository",
        cost_usd_micro: 12_000,
        applied_at: null,
        proposal: {
          plan: {
            reason: "planned from the brief",
            milestones: [],
            tasks: [
              {
                key: "page",
                title: "Build the page",
                outcome: "a page",
                acceptanceCriteria: [],
                priority: 8,
                dependsOn: [],
                specialist: "coder",
              },
            ],
          },
          docs: { "README.md": "# Atlas\n" },
          firstSession: {
            summary: "Build it.",
            items: [{ key: "page", estimateUsdMicro: 400_000 }],
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
    const lines = within(card).getAllByTestId("intake-credential-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent(
      "Your subscription is at its limit until 15:40: you are asked before your API key is used.",
    );
    // At the foot: after the total line.
    const total = within(card).getByTestId("intake-total");
    expect(
      total.compareDocumentPosition(lines[0] as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

/**
 * d1109-cred-screens (CS-10's walk; C3-left-9's class: the sentence names the button beside it):
 * with the key refused under "ask" (no "Use API key" to offer) the one button is "Start at 15:40",
 * kept for the reset; the line under it read "Start: works until ..." for a Start that is not
 * there. It names the button the person presses.
 */
describe("d1109-cred-screens, run C: a kept start alone says its own label (CS-3, C3-left-9)", () => {
  it("the explain line under 'Start at 15:40' begins with 'Start at 15:40', never a bare 'Start:'", async () => {
    const harness = createHarness();
    harness.daemon.state.credentialWaitNow.proj_atlas = {
      text: "Nothing can run until 15:40 (your subscription's limit). Press Start at 15:40 and the work starts then.",
      save: null,
      startable: true,
    };
    harness.daemon.state.startCredential.proj_atlas = { line: null, runOut: null };
    const { dialog } = await openDialog(harness);
    await waitFor(() =>
      expect(within(dialog).getByTestId("confirm-start-session")).toHaveTextContent(
        "Start at 15:40",
      ),
    );
    expect(within(dialog).getByTestId("start-session-explain")).toHaveTextContent(
      /^Start at 15:40: works until nothing more can run, the budget is used, or you stop it\.$/,
    );
  });

  it("a plain Start keeps its line", async () => {
    const harness = createHarness();
    const { dialog } = await openDialog(harness);
    await waitFor(() =>
      expect(within(dialog).getByTestId("confirm-start-session")).toHaveTextContent(/^Start$/),
    );
    expect(within(dialog).getByTestId("start-session-explain")).toHaveTextContent(
      /^Start: works until nothing more can run, the budget is used, or you stop it\.$/,
    );
  });
});

/**
 * l4-cred-screens, run L4 (L4-creds-15, C6L-3; ADR 0120 amended 2026-11-22): with the first
 * choice out and "Use API key" offered, the dialog keeps its plan sentence (which tasks the
 * session runs) beside the stop line, so the figure under "Use API key" is for work the person
 * can see. Before, the stop line replaced the plan sentence and the dialog named no task.
 */
describe("l4-cred-screens, run L4: the plan sentence stays beside the stop line (L4-creds-15)", () => {
  it("under 'ask' with the subscription out: the plan names the task, then the stop line and the two buttons", async () => {
    const harness = createHarness();
    harness.daemon.state.credentialWaitNow.proj_atlas = {
      text: "Nothing can run until 15:40 (your subscription's limit). Press Start at 15:40 and the work starts then.",
      save: null,
      startable: true,
    };
    harness.daemon.state.startCredential.proj_atlas = {
      line: null,
      runOut: {
        use: USE,
        later: LATER,
        lean: "use",
        goesOnLine: null,
        stoppedLine: "Your subscription is at its limit until 15:40.",
      },
    };
    const { dialog } = await openDialog(harness);
    await within(dialog).findByTestId("start-session-run-out");
    expect(within(dialog).getByTestId("start-session-plan")).toHaveTextContent(
      /^This session runs ".+" \(about CHF \d+\.\d\d\)/,
    );
    expect(within(dialog).getByTestId("start-session-blocked")).toHaveTextContent(
      /^Your subscription is at its limit until 15:40\.$/,
    );
  });

  it("a stop no button can run past (Start alone, kept for the reset) shows no plan sentence", async () => {
    const harness = createHarness();
    harness.daemon.state.credentialWaitNow.proj_atlas = {
      text: "Nothing can run until 15:40 (your subscription's limit). Press Start at 15:40 and the work starts then.",
      save: null,
      startable: true,
    };
    harness.daemon.state.startCredential.proj_atlas = { line: null, runOut: null };
    const { dialog } = await openDialog(harness);
    await waitFor(() =>
      expect(within(dialog).getByTestId("confirm-start-session")).toHaveTextContent(
        "Start at 15:40",
      ),
    );
    expect(within(dialog).queryByTestId("start-session-plan")).toBeNull();
  });
});

/**
 * l4-cred-screens, run L4 (L4-creds-17, live check 4's LC-C26): under "API key first, then
 * subscription" with the key at its limit, the dialog's line names the stop and the subscription
 * that runs it, in the daemon's words, with the plain Start.
 */
describe("l4-cred-screens, run L4: the key-first direction in the Start dialog (L4-creds-17)", () => {
  it("shows 'Your API key is at its limit until 11:40, so this runs on your subscription (...)' under the plan, with Start", async () => {
    const harness = createHarness();
    harness.daemon.state.startCredential.proj_atlas = {
      line: "Your API key is at its limit until 11:40, so this runs on your subscription (about CHF 0.07).",
      runOut: null,
    };
    const { dialog } = await openDialog(harness);
    expect(await within(dialog).findByTestId("start-session-credential")).toHaveTextContent(
      /^Your API key is at its limit until 11:40, so this runs on your subscription \(about CHF 0\.07\)\.$/,
    );
    expect(within(dialog).getByTestId("start-session-plan")).toBeInTheDocument();
    expect(within(dialog).getByTestId("confirm-start-session")).toHaveTextContent(/^Start$/);
  });
});
