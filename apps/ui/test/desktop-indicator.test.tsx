import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { EventSourceLike, StreamOptions } from "../src/api/sse.ts";
import { AppRoutes } from "../src/routes.tsx";
import { AppProvider } from "../src/store/context.tsx";
import { createHarness, type Harness, postedCalls } from "./helpers.tsx";

/**
 * Desktop control's on-screen indicator in the app (spec S.32; ADR 0067). The `/events`
 * stream is an EventSource stand-in wired to the fake daemon's listeners, so a
 * `desktop.indicator` frame the fake emits (as the real daemon's `BusIndicator` does) reaches
 * the UI the way it does in the shell, and a dropped and reopened stream can be scripted.
 */
type FakeSource = EventSourceLike & {
  readyState: number;
  /** The stream drops (`readyState` stays CONNECTING, as EventSource retries on its own). */
  drop(): void;
  /** The stream is open again. */
  reopen(): void;
};

function connectedEventSource(harness: Harness) {
  const sources: FakeSource[] = [];
  const factory = (_url: string): EventSourceLike => {
    const listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
    let connected = false;
    const fromDaemon = (event: string, data: unknown) => {
      if (!connected) return; // a frame sent while the stream is down is lost
      for (const l of listeners.get(event) ?? []) l({ data: JSON.stringify(data) } as MessageEvent);
    };
    const es: FakeSource = {
      readyState: 0,
      onerror: null,
      onopen: null,
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        es.readyState = 2;
        connected = false;
        harness.daemon.state.listeners.delete(fromDaemon);
      },
      drop() {
        connected = false;
        es.readyState = 0;
        es.onerror?.(new Event("error"));
      },
      reopen() {
        connected = true;
        es.readyState = 1;
        es.onopen?.(new Event("open"));
      },
    };
    harness.daemon.state.listeners.add(fromDaemon);
    sources.push(es);
    queueMicrotask(() => es.reopen());
    return es;
  };
  const options: StreamOptions = {
    eventSource: factory,
    setTimer: () => 0,
    clearTimer: () => {},
  };
  return { sources, options };
}

function mount(route = "/") {
  const harness = createHarness();
  const { sources, options } = connectedEventSource(harness);
  const utils = render(
    <AppProvider client={harness.client} store={harness.store} streamOptions={options}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProvider>,
  );
  return { ...utils, ...harness, sources };
}

/** The live stream is open and the agents are loaded (the banner names the agent). */
async function ready(h: ReturnType<typeof mount>) {
  await waitFor(() => expect(h.sources[0]?.readyState).toBe(1));
  await waitFor(() => expect(h.store.getState().connection.streamMode).toBe("sse"));
  await waitFor(() => expect(h.store.getState().agents.length).toBeGreaterThan(0));
}

describe("desktop control banner (S.32)", () => {
  it("shows no banner while desktop control is off", async () => {
    const h = mount("/");
    await ready(h);
    // The bootstrap read the status view: off, not stopped.
    await waitFor(() =>
      expect(h.store.getState().desktopControl).toMatchObject({ active: false, revoked: false }),
    );
    expect(screen.queryByTestId("desktop-control-banner")).toBeNull();
    expect(screen.queryByTestId("desktop-control-stopped")).toBeNull();
  });

  it("a desktop.indicator frame that is on shows the banner at the top naming the agent, the app and the session; off hides it", async () => {
    const h = mount("/");
    await ready(h);
    h.daemon.setDesktopControl({ app: "code", sessionId: "sess_2", agentId: "agent_alice" });
    const banner = await screen.findByTestId("desktop-control-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent("Desktop control active");
    expect(within(banner).getByTestId("desktop-control-agent")).toHaveTextContent("Alice's agent");
    expect(within(banner).getByTestId("desktop-control-app")).toHaveTextContent("code");
    const session = within(banner).getByTestId("desktop-control-session");
    expect(session).toHaveTextContent("sess_2");
    expect(session).toHaveAttribute("href", "/sessions/sess_2");
    expect(within(banner).getByTestId("desktop-control-stop")).toHaveTextContent(
      "Stop desktop control",
    );
    // Above the header: the first thing in the window.
    const header = screen.getByTestId("header");
    expect(banner.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.className).toMatch(/bg-red-700/);
    expect(banner.className).toMatch(/text-white/);

    h.daemon.setDesktopControl(null);
    await waitFor(() => expect(screen.queryByTestId("desktop-control-banner")).toBeNull());
    // Off after a normal end is not a stop: no "stopped" line either.
    expect(screen.queryByTestId("desktop-control-stopped")).toBeNull();
  });

  it("an app that becomes known updates the banner, and without one it says the desktop", async () => {
    const h = mount("/");
    await ready(h);
    h.daemon.setDesktopControl({ sessionId: "sess_2", agentId: "agent_alice" });
    expect(await screen.findByTestId("desktop-control-app")).toHaveTextContent("the desktop");
    h.daemon.setDesktopControl({ app: "gimp", sessionId: "sess_2", agentId: "agent_alice" });
    await waitFor(() =>
      expect(screen.getByTestId("desktop-control-app")).toHaveTextContent("gimp"),
    );
  });

  it("stays visible on every page while on (survives navigation)", async () => {
    const user = userEvent.setup();
    const h = mount("/");
    await ready(h);
    h.daemon.setDesktopControl({ app: "code", sessionId: "sess_2", agentId: "agent_alice" });
    await screen.findByTestId("desktop-control-banner");
    const nav = screen.getByTestId("main-nav");
    for (const label of ["Inbox", "Memory", "Extensions", "Settings", "Updates", "Home"]) {
      await user.click(within(nav).getByText(label));
      expect(screen.getByTestId("desktop-control-banner")).toHaveTextContent("code");
    }
    // The session link opens the live session; the banner is still there.
    await user.click(screen.getByTestId("desktop-control-session"));
    expect(screen.getByTestId("desktop-control-banner")).toBeInTheDocument();
  });

  it("re-reads the state from GET /desktop/status when the stream reopens: a missed on shows, a missed off hides", async () => {
    const h = mount("/inbox");
    await ready(h);
    const source = h.sources[0];
    if (!source) throw new Error("no stream");
    // The stream drops; desktop control starts meanwhile and its frame is lost.
    source.drop();
    await waitFor(() => expect(h.store.getState().connection.streamMode).toBe("connecting"));
    h.daemon.setDesktopControl({ app: "code", sessionId: "sess_2", agentId: "agent_alice" });
    expect(screen.queryByTestId("desktop-control-banner")).toBeNull();
    source.reopen();
    const banner = await screen.findByTestId("desktop-control-banner");
    expect(banner).toHaveTextContent("code");
    expect(within(banner).getByTestId("desktop-control-session")).toHaveTextContent("sess_2");
    // It drops again; control ends meanwhile (the off frame is lost); the reopen hides it.
    source.drop();
    await waitFor(() => expect(h.store.getState().connection.streamMode).toBe("connecting"));
    h.daemon.setDesktopControl(null);
    expect(screen.getByTestId("desktop-control-banner")).toBeInTheDocument();
    source.reopen();
    await waitFor(() => expect(screen.queryByTestId("desktop-control-banner")).toBeNull());
  });

  it("a status read that was answered before a newer frame does not overwrite it (reconnect race)", async () => {
    const h = mount("/inbox");
    await ready(h);
    const source = h.sources[0];
    if (!source) throw new Error("no stream");
    // The daemon answers the re-read while control is still off, but the answer reaches the
    // UI only after the `on` frame sent right afterwards (two connections, no ordering).
    const real = h.client.desktopStatus.bind(h.client);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let reads = 0;
    h.client.desktopStatus = async (signal) => {
      reads++;
      const answer = await real(signal);
      await held;
      return answer;
    };
    source.drop();
    await waitFor(() => expect(h.store.getState().connection.streamMode).toBe("connecting"));
    source.reopen();
    await waitFor(() => expect(reads).toBe(1));
    // let the read reach the fake daemon before control starts
    await new Promise((r) => setTimeout(r, 10));
    h.daemon.setDesktopControl({ app: "code", sessionId: "sess_2", agentId: "agent_alice" });
    await screen.findByTestId("desktop-control-banner");
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId("desktop-control-banner")).toHaveTextContent("code");
    expect(h.store.getState().desktopControl?.active).toBe(true);
  });

  it("shows the banner at start-up when desktop control is already active (bootstrap read)", async () => {
    const harness = createHarness();
    harness.daemon.setDesktopControl(
      { app: "code", sessionId: "sess_2", agentId: "agent_alice" },
      true,
    );
    const { options } = connectedEventSource(harness);
    render(
      <AppProvider client={harness.client} store={harness.store} streamOptions={options}>
        <MemoryRouter initialEntries={["/settings"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    expect(await screen.findByTestId("desktop-control-banner")).toHaveTextContent("code");
  });

  it("'Stop desktop control' calls POST /desktop/revoke, hides the banner, and offers resume", async () => {
    const user = userEvent.setup();
    const h = mount("/");
    await ready(h);
    h.daemon.setDesktopControl({ app: "code", sessionId: "sess_2", agentId: "agent_alice" });
    await screen.findByTestId("desktop-control-banner");
    await user.click(screen.getByTestId("desktop-control-stop"));
    await waitFor(() => expect(postedCalls(h, "/desktop/revoke")).toHaveLength(1));
    expect(postedCalls(h, "/desktop/revoke")[0]?.body).toEqual({
      reason: "stopped from the desktop control banner",
    });
    // The kill switch for all sessions is not what was pressed.
    expect(postedCalls(h, "/kill")).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId("desktop-control-banner")).toBeNull());
    expect(await screen.findByTestId("desktop-control-stopped")).toHaveTextContent(
      "Desktop control is stopped",
    );
    await user.click(screen.getByTestId("desktop-control-resume"));
    await waitFor(() => expect(postedCalls(h, "/desktop/resume")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("desktop-control-stopped")).toBeNull());
  });

  it("a stop from the tray offers resume at once; a revoke by the Extensions panel shows no stopped line", async () => {
    const h = mount("/");
    await ready(h);
    const source = h.sources[0];
    if (!source) throw new Error("no stream");
    h.daemon.setDesktopControl({ app: "code", sessionId: "sess_2", agentId: "agent_alice" });
    await screen.findByTestId("desktop-control-banner");
    // The tray's "Stop desktop control" revokes on the daemon: the window only sees the off frame.
    h.daemon.state.desktop.revoked = true;
    h.daemon.state.desktop.revokedReason = "stopped from the tray";
    h.daemon.setDesktopControl(null);
    expect(await screen.findByTestId("desktop-control-stopped")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-control-banner")).toBeNull();
    // The capability disabled in the Extensions panel revokes it too: the panel is where that
    // is undone, so no line nags on every page and no "Resume" pretends to undo it.
    h.daemon.state.desktop.revokedReason = "desktop-control disabled in the Extensions panel";
    source.drop();
    await waitFor(() => expect(h.store.getState().connection.streamMode).toBe("connecting"));
    source.reopen();
    await waitFor(() =>
      expect(h.store.getState().desktopControl).toMatchObject({ active: false, revoked: false }),
    );
    expect(screen.queryByTestId("desktop-control-stopped")).toBeNull();
    expect(screen.queryByTestId("desktop-control-resume")).toBeNull();
  });

  it("a failed stop keeps the banner and says so", async () => {
    const user = userEvent.setup();
    const h = mount("/");
    await ready(h);
    h.daemon.setDesktopControl({ app: "code", sessionId: "sess_2", agentId: "agent_alice" });
    await screen.findByTestId("desktop-control-banner");
    h.daemon.state.failing["/desktop/revoke"] = {
      status: 503,
      code: "unavailable",
      message: "controller busy",
    };
    await user.click(screen.getByTestId("desktop-control-stop"));
    expect(await screen.findByTestId("desktop-control-error")).toHaveTextContent("Stop failed");
    expect(screen.getByTestId("desktop-control-banner")).toBeInTheDocument();
  });

  it("polling mode reads the indicator from the status view", async () => {
    const harness = createHarness();
    harness.daemon.setDesktopControl(
      { app: "code", sessionId: "sess_2", agentId: "agent_alice" },
      true,
    );
    const timers: Array<() => void> = [];
    render(
      <AppProvider
        client={harness.client}
        store={harness.store}
        streamOptions={{
          eventSource: undefined,
          setTimer: (fn) => {
            timers.push(fn);
            return timers.length;
          },
          clearTimer: () => {},
        }}
      >
        <MemoryRouter initialEntries={["/"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    expect(await screen.findByTestId("desktop-control-banner")).toHaveTextContent("code");
    await waitFor(() => expect(harness.store.getState().connection.streamMode).toBe("polling"));
    harness.daemon.setDesktopControl(null, true);
    timers.at(-1)?.();
    await waitFor(() => expect(screen.queryByTestId("desktop-control-banner")).toBeNull());
  });
});
