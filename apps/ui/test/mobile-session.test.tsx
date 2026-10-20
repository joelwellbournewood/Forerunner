import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventView, SessionView } from "../src/api/state-client.ts";
import { AGENT_J, money } from "./fake-state-service.ts";
import { createMobileHarness, renderMobile } from "./mobile-helpers.tsx";

function sessionFixture(id: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    agentId: AGENT_J.id,
    agentName: AGENT_J.name,
    projectId: "proj_game",
    trigger: "remote",
    status: "running",
    startedAt: "2026-10-20T09:50:00.000Z",
    endedAt: null,
    budgetCap: money(6_250_000),
    spent: money(1_250_000),
    stepCap: 60,
    steps: 12,
    currentTask: { id: "task_7", title: "Trading loop", specialist: "coder" },
    summary: "",
    handoff: null,
    runner: "pc",
    ...over,
  };
}

function eventFixture(
  sessionId: string,
  seq: number,
  level: EventView["level"],
  text: string,
): EventView {
  return {
    id: `ev_${seq}`,
    sessionId,
    seq,
    type: "step",
    text,
    payload: null,
    cost: money(0),
    at: `2026-10-20T09:5${seq}:00.000Z`,
    level,
  };
}

describe("Session screen (spec R.4: watch the live session log)", () => {
  it("shows the session header, appends events as they arrive and highlights escalations (polling)", async () => {
    const h = await createMobileHarness();
    const id = "sess_live";
    h.service.state.sessions.push(sessionFixture(id));
    h.service.state.events.push(
      eventFixture(id, 1, "info", "Claimed task Trading loop"),
      eventFixture(id, 2, "escalation", "Budget at 80 percent; asking the human"),
      eventFixture(id, 3, "error", "Test suite failed once; retrying"),
    );
    renderMobile(`/sessions/${id}`, h);
    await screen.findByRole("heading", { name: "Live session" });
    const header = await screen.findByTestId("m-session-header");
    expect(header).toHaveTextContent("J's agent");
    expect(header).toHaveTextContent("running");
    expect(header).toHaveTextContent("12/60 steps");
    expect(header).toHaveTextContent("Now: Trading loop (coder)");
    await waitFor(() => expect(screen.getByTestId("m-session-mode")).toHaveTextContent("polling"));

    const list = screen.getByTestId("m-session-events");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-level"))).toEqual([
      "info",
      "escalation",
      "error",
    ]);
    expect(items[1]?.className).toMatch(/bg-amber-100/);
    expect(items[2]?.className).toMatch(/bg-red-100/);
    expect(items[0]?.className).not.toMatch(/bg-amber-100|bg-red-100/);
    expect(items[1]).toHaveTextContent("Budget at 80 percent; asking the human");

    // A later event is appended once; a session change updates the header.
    h.service.state.events.push(eventFixture(id, 4, "info", "PR opened"));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));
    const row = h.service.state.sessions.find((s) => s.id === id);
    if (row) {
      row.status = "completed";
      row.steps = 20;
    }
    await waitFor(() =>
      expect(screen.getByTestId("m-session-header")).toHaveTextContent("completed"),
    );
    expect(screen.getByTestId("m-session-header")).toHaveTextContent("20/60 steps");
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  });

  it("over the live stream the mode badge says live and a repeated seq is shown once", async () => {
    const h = await createMobileHarness({ env: { live: true } });
    const id = "sess_stream";
    h.service.state.sessions.push(sessionFixture(id, { steps: 3 }));
    const first = eventFixture(id, 1, "info", "Started");
    // The stream replays what the fake holds; the same seq twice must not render twice.
    h.service.state.events.push(first, first, eventFixture(id, 2, "warning", "Slow tool"));
    renderMobile(`/sessions/${id}`, h);
    await screen.findByRole("heading", { name: "Live session" });
    await waitFor(() => expect(screen.getByTestId("m-session-mode")).toHaveTextContent("live"), {
      timeout: 3000,
    });
    const list = screen.getByTestId("m-session-events");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("Started"), expect.stringContaining("Slow tool")]);
    expect(screen.getByTestId("m-session-header")).toHaveTextContent("3/60 steps");
  });

  it("names a missing session instead of crashing", async () => {
    const h = await createMobileHarness();
    renderMobile("/sessions/sess_missing", h);
    await screen.findByRole("heading", { name: "Live session" });
    await waitFor(() => expect(screen.getByText(/session not found/)).toBeInTheDocument());
    expect(screen.queryByTestId("m-session-header")).toBeNull();
  });
});
