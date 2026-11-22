import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionView } from "../src/api/client.ts";
import { createHarness, renderApp } from "./helpers.tsx";

/**
 * l4-cred-screens, run L4 (L4-creds-18, C6L-5; ADR 0120 amended 2026-11-22): the share's wait
 * offers "Change the allowance" wherever it shows, not only on the run bar: the project's status
 * line (the daemon's `startsWaitOf` gives the waiting continuation its link) and the session
 * page's ended-to-wait block (`waitBlock.answer`), each a link to Settings' allowance.
 */
const ALLOWANCE = { label: "Change the allowance", to: "/settings#plan-allowance" };

describe("l4-cred-screens, run L4: Change the allowance wherever the share's wait shows (L4-creds-18)", () => {
  it("the Overview's status line of a session waiting on the share links to the allowance", async () => {
    const harness = createHarness();
    // Nothing else of the project needs the person or runs, so the wait is what the line says.
    const others = harness.daemon.state.requests.filter((r) => r.projectId !== "proj_atlas");
    harness.daemon.state.requests.splice(0, Infinity, ...others);
    harness.daemon.state.sessions.splice(0, Infinity);
    harness.daemon.state.startsWait.proj_atlas = {
      kind: "continuation",
      head: "Waiting until Tue 1 Dec (your subscription's share)",
      save: ALLOWANCE,
    };
    renderApp("/projects/proj_atlas", harness);
    const status = await screen.findByTestId("project-status");
    expect(status).toHaveTextContent(
      "Waiting until Tue 1 Dec (your subscription's share), then it goes on",
    );
    const header = screen.getByTestId("project-header");
    expect(within(header).getByRole("link", { name: "Change the allowance" })).toHaveAttribute(
      "href",
      "/settings#plan-allowance",
    );
  });

  it("the session page's wait block offers Change the allowance beside Cancel", async () => {
    const harness = createHarness();
    const s = harness.daemon.state.sessions[0] as SessionView;
    s.status = "completed";
    s.stopReason = "credential_wait";
    s.projectId = "proj_atlas";
    s.waitBlock = {
      state: "goes_on",
      text: 'Waiting until Tue 1 Dec (your subscription\'s share), then it goes on with "B".',
      action: "cancel",
      explain: "Cancel: nothing starts by itself then; its tasks wait for your Start.",
      projectId: "proj_atlas",
      budgetLeft: { usdMicro: 1_500_000, chfMicro: 1_200_000 },
      answer: ALLOWANCE,
    };
    renderApp(`/sessions/${s.id}`, harness);
    const block = await screen.findByTestId("session-wait");
    const link = within(block).getByTestId("session-wait-answer");
    expect(link).toHaveTextContent("Change the allowance");
    expect(link).toHaveAttribute("href", "/settings#plan-allowance");
    expect(within(block).getByTestId("session-wait-cancel")).toBeInTheDocument();
  });
});
