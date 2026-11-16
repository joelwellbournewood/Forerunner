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
      runOut: { use: USE, later: LATER, lean: "use", goesOnLine: null },
    };
    const { user, dialog } = await openDialog(harness);
    const list = await within(dialog).findByTestId("start-session-run-out");
    const buttons = within(list)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(buttons).toEqual(["Use API key", "Start at 15:40"]);
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
      runOut: { use: USE, later: LATER, lean: "later", goesOnLine: null },
    };
    const { user, dialog } = await openDialog(harness);
    const list = await within(dialog).findByTestId("start-session-run-out");
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Start at 15:40", "Use API key"]);
    // C3-left-9: the sentence names the button beside it.
    expect(within(dialog).getByTestId("start-session-blocked")).toHaveTextContent(
      "Nothing can run until 15:40 (your subscription's limit). Press Start at 15:40 and the work starts then.",
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
});
