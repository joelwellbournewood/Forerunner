import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { EventSourceLike, StreamOptions } from "../src/api/sse.ts";
import { AppRoutes } from "../src/routes.tsx";
import { AppProvider } from "../src/store/context.tsx";
import { ownPrincipal } from "../src/store/store.ts";
import { createHarness, type Harness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Settings -> Your agent (U-025): the principal agent was created as "Alice" and nothing could
 * rename it. The field shows the current name, Save posts `POST /agents/:id/rename`, the
 * daemon's refusal shows as it says it, and after a save (or an `agent.changed` frame from
 * another window) `/me` and `/agents` are read again so every place shows the new name.
 */

const RENAME = "/agents/agent_alice/rename";

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

describe("Settings -> Your agent (U-025)", () => {
  it("shows the agent's name, saves a new one and the app reads it everywhere", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const section = await screen.findByTestId("agent-name-section");
    const input = (await within(section).findByTestId("agent-name-input")) as HTMLInputElement;
    expect(input.value).toBe("Alice's agent");
    const save = within(section).getByTestId("agent-name-save");
    // Nothing to save until the name differs, and a blank name is not sent.
    expect(save).toBeDisabled();
    await user.clear(input);
    expect(save).toBeDisabled();
    await user.type(input, "  Robin  ");
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(postedCalls(harness, RENAME)).toHaveLength(1));
    expect(postedCalls(harness, RENAME)[0]?.body).toEqual({ name: "  Robin  " });
    expect(await within(section).findByTestId("agent-name-saved")).toHaveTextContent(
      "Saved. Your agent is now called Robin.",
    );
    // `/agents` (and `/me`) were read again: the store, and with it every page, has the name.
    await waitFor(() => expect(input.value).toBe("Robin"));
    expect(ownPrincipal(harness.store.getState())?.name).toBe("Robin");
    expect(harness.daemon.state.agents.find((a) => a.id === "agent_alice")?.name).toBe("Robin");
    expect(save).toBeDisabled();
    expect(within(section).queryByTestId("agent-name-error")).toBeNull();
  });

  it("shows the daemon's refusal and keeps the name", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const section = await screen.findByTestId("agent-name-section");
    const input = (await within(section).findByTestId("agent-name-input")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Alice's agent"));
    // The critic is one of the human's agents: its name is taken, whatever the case.
    await user.clear(input);
    await user.type(input, "critic");
    await user.click(within(section).getByTestId("agent-name-save"));
    expect(await within(section).findByTestId("agent-name-error")).toHaveTextContent(
      "you already have an agent named Critic; choose another name",
    );
    expect(input.value).toBe("critic");
    expect(within(section).queryByTestId("agent-name-saved")).toBeNull();
    expect(ownPrincipal(harness.store.getState())?.name).toBe("Alice's agent");
    expect(harness.daemon.state.agents.find((a) => a.id === "agent_alice")?.name).toBe(
      "Alice's agent",
    );
  });

  it("follows a rename made in another window through agent.changed", async () => {
    const harness = createHarness();
    render(
      <AppProvider
        client={harness.client}
        store={harness.store}
        streamOptions={liveEvents(harness)}
      >
        <MemoryRouter initialEntries={["/settings"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    const section = await screen.findByTestId("agent-name-section");
    const input = (await within(section).findByTestId("agent-name-input")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Alice's agent"));
    await waitFor(() => expect(harness.daemon.state.listeners.size).toBeGreaterThan(0));
    // Another window saves; this one only hears the daemon's frame.
    await harness.client.renameAgent("agent_alice", "Sam");
    await waitFor(() => expect(input.value).toBe("Sam"));
    expect(ownPrincipal(harness.store.getState())?.name).toBe("Sam");
  });
});
