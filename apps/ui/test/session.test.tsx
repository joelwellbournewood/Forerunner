import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/api/client.ts";
import { SessionPage } from "../src/pages/SessionPage.tsx";
import { AppProvider } from "../src/store/context.tsx";
import { createHarness, fetchFromApp, postedCalls, renderApp, testConfig } from "./helpers.tsx";

describe("Live session view", () => {
  it("shows the header, the readable stream and highlights escalations", async () => {
    renderApp("/sessions/sess_1");
    const header = await screen.findByTestId("session-header");
    expect(within(header).getByTestId("session-status")).toHaveTextContent("completed");
    expect(within(header).getByTestId("steps")).toHaveTextContent("57 / 200");
    expect(within(header).getByTestId("session-spend")).toHaveTextContent("CHF 5.80 of CHF 5.00");
    expect(within(header).getByTestId("current-task")).toHaveTextContent("no task running");

    const rows = await screen.findAllByTestId("event-row");
    expect(rows).toHaveLength(5);
    const escalation = rows.find((r) => r.getAttribute("data-level") === "escalation");
    expect(escalation).toBeDefined();
    expect(escalation).toHaveTextContent("Deploy to staging needs your approval");
    expect(within(escalation as HTMLElement).getByTestId("level-badge")).toHaveTextContent(
      "escalation",
    );
    expect(escalation?.className).toMatch(/border-red-500/);
    const info = rows.find((r) => r.getAttribute("data-level") === "info");
    expect(within(info as HTMLElement).queryByTestId("level-badge")).not.toBeInTheDocument();
    expect(info?.className).not.toMatch(/border-red-500/);
    expect(screen.queryByTestId("event-raw")).not.toBeInTheDocument();
  });

  it("reads the session summary aloud through the daemon", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/sessions/sess_1", harness);
    await screen.findByTestId("session-header");
    expect(screen.getByTestId("session-summary")).toBeInTheDocument();
    await user.click(screen.getByTestId("session-read-aloud"));
    const text = await screen.findByTestId("session-read-aloud-text");
    expect(text.textContent?.trim().length).toBeGreaterThan(0);
    expect(postedCalls(harness, "/sessions/sess_1/speak")).toHaveLength(1);
    expect(screen.getByTestId("session-read-aloud")).toHaveTextContent("Stop reading");
  });

  it("filters by level and toggles raw output", async () => {
    const user = userEvent.setup();
    renderApp("/sessions/sess_1");
    await screen.findAllByTestId("event-row");
    await user.click(screen.getByTestId("filter-info"));
    await waitFor(() => expect(screen.getAllByTestId("event-row")).toHaveLength(2));
    expect(screen.getByTestId("filter-info")).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByTestId("filter-info"));
    await waitFor(() => expect(screen.getAllByTestId("event-row")).toHaveLength(5));

    await user.click(screen.getByTestId("raw-toggle"));
    const raw = await screen.findAllByTestId("event-raw");
    expect(raw).toHaveLength(5);
    expect(raw[3]).toHaveTextContent('"requestId": "req_1"');
    await user.click(screen.getByTestId("raw-toggle"));
    await waitFor(() => expect(screen.queryByTestId("event-raw")).not.toBeInTheDocument());
  });

  it("stops a running session and keeps receiving events through the polling fallback", async () => {
    const user = userEvent.setup();
    // Events 2 s apart: the session is still running when Stop is pressed.
    const harness = createHarness({ eventDelayMs: 2000 });
    const { session } = await harness.client.startSession({
      agentId: "agent_alice",
      projectId: "proj_atlas",
    });
    if (!session) throw new Error("the fake daemon started no session");
    renderApp(`/sessions/${session.id}`, harness);
    const header = await screen.findByTestId("session-header");
    expect(within(header).getByTestId("session-status")).toHaveTextContent("running");
    // jsdom has no EventSource: the helper must say so and poll instead of spinning silently.
    await waitFor(() =>
      expect(screen.getByTestId("stream-mode")).toHaveTextContent("polling every 5 s"),
    );
    expect(screen.getByTestId("stream-notice")).toHaveTextContent(/polling every 5 s/);
    await user.click(screen.getByTestId("stop-session"));
    await waitFor(() =>
      expect(postedCalls(harness, `/sessions/${session.id}/stop`)).toHaveLength(1),
    );
    await waitFor(() =>
      expect(within(header).getByTestId("session-status")).toHaveTextContent("stopped"),
    );
  });
});

/** A client over the fake that counts the GETs of one route prefix (U-071). */
function countingHarness(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(options);
  const inner = fetchFromApp(harness.daemon.app);
  const gets: string[] = [];
  const client = createClient(testConfig(), (input, init) => {
    if (!init?.method || init.method === "GET") gets.push(new URL(input).pathname);
    return inner(input, init);
  });
  return { ...harness, client, gets };
}

describe("a finished session's page (U-071)", () => {
  it("shows a finished session as finished and does not stream or poll it", async () => {
    const h = countingHarness();
    const streamOptions = { pollIntervalMs: 20 };
    render(
      <AppProvider
        client={h.client}
        store={h.store}
        bootstrap={false}
        streamOptions={streamOptions}
      >
        <MemoryRouter initialEntries={["/sessions/sess_1"]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );
    const header = await screen.findByTestId("session-header");
    expect(within(header).getByTestId("session-status")).toHaveTextContent("completed");
    expect(screen.getByTestId("stream-mode")).toHaveTextContent("finished");
    await new Promise((r) => setTimeout(r, 150));
    expect(h.gets.filter((p) => p === "/sessions/sess_1/events")).toHaveLength(1);
    expect(screen.getByTestId("stream-mode")).toHaveTextContent("finished");
    expect(screen.queryByTestId("stream-notice")).not.toBeInTheDocument();
  });

  it("stops following a session once it ends while the page is open", async () => {
    const h = countingHarness({ eventDelayMs: 30 });
    const { session } = await h.client.startSession({
      agentId: "agent_alice",
      projectId: "proj_atlas",
    });
    if (!session) throw new Error("the fake daemon started no session");
    const streamOptions = { pollIntervalMs: 20 };
    render(
      <AppProvider
        client={h.client}
        store={h.store}
        bootstrap={false}
        streamOptions={streamOptions}
      >
        <MemoryRouter initialEntries={[`/sessions/${session.id}`]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("session-status")).toHaveTextContent("running"));
    await waitFor(() =>
      expect(screen.getByTestId("session-status")).toHaveTextContent("completed"),
    );
    await waitFor(() => expect(screen.getByTestId("stream-mode")).toHaveTextContent("finished"));
    expect(screen.getAllByTestId("event-row").length).toBeGreaterThanOrEqual(6);
    const polled = h.gets.filter((p) => p === `/sessions/${session.id}/events`).length;
    await new Promise((r) => setTimeout(r, 150));
    expect(h.gets.filter((p) => p === `/sessions/${session.id}/events`)).toHaveLength(polled);
  });
});
