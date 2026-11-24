import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type FetchLike } from "../src/api/client.ts";
import type { EventSourceLike, StreamOptions } from "../src/api/sse.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import { formatTime, setPersonZone } from "../src/lib/time.ts";
import { createStore } from "../src/store/store.ts";
import { createFakeDaemon, type FakeDaemonOptions } from "./fake-daemon.ts";
import {
  createHarness,
  fetchFromApp,
  type Harness,
  postedCalls,
  renderApp,
  testConfig,
} from "./helpers.tsx";

/**
 * w8-two-homes, wave 8: state read from `GET /me` before it has answered (L4i-left-3,
 * L4i-left-62). The held harness keeps `/me` back until the test lets it go, as a slow daemon
 * does at the app's start: every other route answers at once.
 */
function heldMeHarness(options: FakeDaemonOptions = {}): Harness & { releaseMe: () => void } {
  const token = "test-token";
  const daemon = createFakeDaemon({ eventDelayMs: 20, tokenDelayMs: 0, ...options, token });
  let releaseMe = () => {};
  const held = new Promise<void>((resolve) => {
    releaseMe = resolve;
  });
  const base = fetchFromApp(daemon.app);
  const fetchImpl: FetchLike = async (input, init) => {
    if (new URL(input).pathname === "/me") await held;
    return base(input, init);
  };
  const config = testConfig(token);
  const client = createClient(config, fetchImpl);
  const storage = memoryStorage();
  const store = createStore(config, storage);
  return { client, store, storage, daemon, releaseMe };
}

/** An `/events` EventSource wired to the fake daemon's frames, open at once. */
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

const TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterEach(() => setPersonZone(null));
afterAll(() => {
  if (TZ === undefined) delete process.env.TZ;
  else process.env.TZ = TZ;
});

describe("w8-two-homes, wave 8: state read from /me before it answers", () => {
  // L4i-left-3: the model watch's answer went as "human" when pressed before /me had answered
  // (`me?.id ?? "human"`), so the decision was recorded for nobody (e2e/updates.spec.ts failed
  // once on it). The press waits for the person: nothing is sent until /me answers, then the
  // person's own id goes over the wire.
  it("the model watch's answer sends nothing until /me answers, then the person's id", async () => {
    const user = userEvent.setup();
    const harness = heldMeHarness();
    renderApp("/updates", harness);
    const latest = await screen.findByTestId("model-watch-latest");
    expect(latest).toHaveAttribute("data-decision", "pending");
    const adopt = within(latest).getByTestId("model-watch-adopt");
    expect(adopt).toBeDisabled();
    for (const id of ["model-watch-ignore", "model-watch-remind", "model-watch-evaluate"]) {
      expect(within(latest).getByTestId(id)).toBeDisabled();
    }
    await user.click(adopt);
    // A few event-loop turns: a press that would send has sent by now.
    await new Promise((r) => setTimeout(r, 50));
    expect(postedCalls(harness, "/model-watch/reports/mw_2/answer")).toHaveLength(0);

    harness.releaseMe();
    await waitFor(() => expect(within(latest).getByTestId("model-watch-adopt")).toBeEnabled());
    await user.click(within(latest).getByTestId("model-watch-adopt"));
    await waitFor(() =>
      expect(postedCalls(harness, "/model-watch/reports/mw_2/answer")).toHaveLength(1),
    );
    expect(postedCalls(harness, "/model-watch/reports/mw_2/answer")[0]?.body).toEqual({
      decision: "adopt",
      by: "human_alice",
      adopt: ["rec_1", "rec_2"],
    });
  });

  // L4i-left-62: the person's zone was set inside the store's reducer and nothing above the
  // routes read it, so a screen already drawn kept the old clock when /me answered with a new
  // zone (a re-read after the setup assistant's save, or after another window's change). The
  // fake's person is in Europe/Zurich; sess_1 started at 19:00 UTC on 19 Oct 2026: 21:00 in
  // Zurich, 15:00 in New York.
  it("a session page on screen follows the person's new zone when /me is read again", async () => {
    const harness = createHarness();
    renderApp("/sessions/sess_1", harness, liveEvents(harness));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Atlas · session at 21:00",
      ),
    );
    await waitFor(() => expect(harness.daemon.state.listeners.size).toBeGreaterThan(0));
    // The person moves to New York in the setup assistant (its route, from another window);
    // a change there makes this window read /me again (agent.changed).
    await harness.client.setupProfile({ name: "Alice", timezone: "America/New_York" });
    await harness.client.renameAgent("agent_alice", "Sam");
    await waitFor(() => expect(harness.store.getState().me?.timezone).toBe("America/New_York"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Atlas · session at 15:00",
      ),
    );
  });

  // L4i-left-62: the setup assistant (Settings -> Open the setup assistant) saved the zone and
  // never read /me again, so every clock stayed in the old zone until a restart or a project
  // switch. After Continue the app reads /me again and writes the new zone's times.
  it("the setup assistant's zone reaches the app's clocks without a restart", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/setup", harness);
    const zone = await screen.findByTestId("setup-timezone");
    await waitFor(() => expect(harness.store.getState().me?.timezone).toBe("Europe/Zurich"));
    await user.clear(zone);
    await user.type(zone, "America/New_York");
    await user.click(screen.getByTestId("setup-next"));
    await waitFor(() =>
      expect(postedCalls(harness, "/setup/profile").map((c) => c.body)).toEqual([
        { name: "Alice", timezone: "America/New_York" },
      ]),
    );
    await waitFor(() => expect(harness.store.getState().me?.timezone).toBe("America/New_York"));
    expect(formatTime("2026-10-19T19:00:00Z")).toBe("15:00");
  });
});
