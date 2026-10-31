import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { type DaemonClient, describeError } from "../api/client.ts";
import {
  type EventSourceFactory,
  type StreamOptions,
  type StreamSubscription,
  subscribeDaemonEvents,
} from "../api/sse.ts";
import {
  type AudioOutput,
  canPlaySpeech,
  createSpeechAnnouncer,
  type SpeechAnnouncer,
} from "../lib/speech.ts";
import {
  defaultAgent,
  desktopControlFromIndicator,
  desktopControlFromStatus,
  type UiState,
  type UiStore,
} from "./store.ts";
import { applyTheme, watchSystemTheme } from "./theme.ts";

/** The browser seams of what the window plays (tests inject fakes); absent: the browser's own. */
export interface RealtimeSeams {
  eventSource?: EventSourceFactory;
  audio?: () => AudioOutput | null;
  /** The page's clock in ms (`performance.now()` by default): the voice player's heard figure. */
  now?: () => number;
}

interface AppContextValue {
  client: DaemonClient;
  store: UiStore;
  realtime: RealtimeSeams | undefined;
  /** The stream options the provider was given (tests set a short poll); pages reuse them. */
  streamOptions: StreamOptions | undefined;
}

const AppContext = createContext<AppContextValue | null>(null);

export interface AppProviderProps {
  client: DaemonClient;
  store: UiStore;
  /** Load health, me, agents, projects, inbox on mount and open the /events stream. */
  bootstrap?: boolean;
  /** Options of the `/events` subscription (tests inject an EventSource and timers). */
  streamOptions?: StreamOptions;
  /**
   * The browser seams of the speech player (tests inject fakes). By default the browser's
   * EventSource, and the window is a speech player when it has EventSource and Web Audio
   * (`canPlaySpeech`); with `audio` given it is one. An `eventSource` given here is also the
   * `/events` stream's, over `streamOptions.eventSource`.
   */
  realtime?: RealtimeSeams;
  children: ReactNode;
}

export function AppProvider({
  client,
  store,
  bootstrap = true,
  streamOptions,
  realtime,
  children,
}: AppProviderProps) {
  // "Retry" in the header bumps this (U-071): the effect below connects again.
  const attempt = useSyncExternalStore(
    store.subscribe,
    () => store.getState().connection.attempt,
    () => store.getState().connection.attempt,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` only re-runs the effect
  useEffect(() => {
    if (!bootstrap) return;
    const controller = new AbortController();
    let stream: StreamSubscription | null = null;
    const setTimer = streamOptions?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer =
      streamOptions?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    let retryHandle: unknown = null;
    // The window plays what the daemon reads aloud on its own (voice alerts, summary.speak by
    // chat; ADR 0063) and says so on /events, so the daemon knows someone can hear it.
    const announcer: SpeechAnnouncer | null =
      realtime?.audio || canPlaySpeech()
        ? createSpeechAnnouncer(client, {
            ...(realtime && "eventSource" in realtime ? { eventSource: realtime.eventSource } : {}),
            ...(realtime?.audio ? { audio: realtime.audio } : {}),
          })
        : null;
    void bootstrapStore(client, store, controller.signal).then((ok) => {
      if (controller.signal.aborted) return;
      if (!ok) {
        // Nothing answered (U-071): try again on the polling cadence; "Retry" does it now.
        retryHandle = setTimer(() => {
          if (!controller.signal.aborted) store.dispatch({ type: "reconnect" });
        }, streamOptions?.pollIntervalMs ?? 5000);
        return;
      }
      const me = store.getState().me;
      if (!me) return;
      stream = subscribeDaemonEvents(
        client,
        me.id,
        {
          onEvent: (event) => {
            if (event.event === "speak.started") {
              announcer?.started(event.data);
            } else if (event.event === "inbox.changed") {
              store.dispatch({ type: "blockingCount", count: event.data.blockingCount });
            } else if (event.event === "project.changed") {
              void client
                .project(event.data.id)
                .then((project) => store.dispatch({ type: "project.upsert", project }))
                .catch(() => {});
            } else if (event.event === "agent.changed") {
              // Renamed in Settings, here or in another window (U-025).
              void refreshIdentity(client, store).catch(() => {});
            } else if (event.event === "extension.changed") {
              store.dispatch({ type: "extension.changed" });
              // A panel toggle of desktop-control revokes or resumes it: re-read the state.
              void refreshDesktopControl(client, store);
            } else if (event.event === "restart.requested") {
              store.dispatch({ type: "restart", restart: event.data });
            } else if (event.event === "desktop.indicator") {
              const previous = store.getState().desktopControl;
              store.dispatch({
                type: "desktopControl",
                desktopControl: desktopControlFromIndicator(event.data, previous),
              });
              // Control just ended: re-read whether it was a stop (from this window, the tray
              // or the route), so the banner can offer "Resume" whoever stopped it.
              if (previous?.active && !event.data.on) void refreshDesktopControl(client, store);
            } else if (event.event === "heartbeat") {
              store.dispatch({
                type: "connection",
                patch: { lastHeartbeatAt: event.data.at },
              });
              // While a restart is announced, every heartbeat re-reads /health: a daemon on the
              // version the restart aimed at means it is back, and the banner goes.
              const restart = store.getState().restart;
              if (restart) {
                client
                  .health()
                  .then((health) => {
                    store.dispatch({ type: "connection", patch: { health } });
                    if (health.version === restart.targetVersion) {
                      store.dispatch({ type: "restart", restart: null });
                    }
                  })
                  .catch(() => {});
              }
            }
          },
          // The status follows what the daemon does (U-071): a poll it does not answer, or
          // refuses (401), is "not connected"; the next answer is "connected" again, and what
          // may have changed meanwhile (projects, the kill switch) is read again.
          onDown: (error) => {
            store.dispatch({
              type: "connection",
              patch: { status: "disconnected", error: describeError(error) },
            });
          },
          onUp: () => {
            if (store.getState().connection.status === "connected") return;
            store.dispatch({ type: "connection", patch: { status: "connected", error: null } });
            void client
              .health()
              .then((health) => {
                store.dispatch({ type: "connection", patch: { health } });
                store.dispatch({ type: "killActive", active: health.killActive });
              })
              .catch(() => {});
            void refreshProjects(client, store).catch(() => {});
          },
          onMode: (mode) => {
            store.dispatch({ type: "connection", patch: { streamMode: mode } });
            // The stream (re)opened: frames sent while it was down are lost, so the desktop
            // control banner re-reads its state from the daemon (spec S.32, ADR 0067).
            if (mode === "sse") void refreshDesktopControl(client, store);
          },
        },
        {
          ...streamOptions,
          speechPlayer: announcer !== null,
          ...(realtime && "eventSource" in realtime ? { eventSource: realtime.eventSource } : {}),
        },
      );
    });
    return () => {
      controller.abort();
      if (retryHandle !== null) clearTimer(retryHandle);
      stream?.close();
      announcer?.close();
    };
  }, [client, store, bootstrap, streamOptions, realtime, attempt]);

  useEffect(() => {
    applyTheme(store.getState().theme);
    const unsubscribeStore = store.subscribe(() => applyTheme(store.getState().theme));
    const unsubscribeSystem = watchSystemTheme(() => applyTheme(store.getState().theme));
    return () => {
      unsubscribeStore();
      unsubscribeSystem();
    };
  }, [store]);

  const value = useMemo(
    () => ({ client, store, realtime, streamOptions }),
    [client, store, realtime, streamOptions],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Fetch the install-wide state once; returns false when the daemon cannot be reached. */
export async function bootstrapStore(
  client: DaemonClient,
  store: UiStore,
  signal?: AbortSignal,
): Promise<boolean> {
  // A retry while not connected keeps saying so until the daemon answers (U-071).
  if (store.getState().connection.status !== "disconnected") {
    store.dispatch({ type: "connection", patch: { status: "connecting", error: null } });
  }
  try {
    const health = await client.health(signal);
    store.dispatch({
      type: "connection",
      patch: { status: "connected", health, error: null },
    });
    store.dispatch({ type: "killActive", active: health.killActive });
  } catch (error) {
    store.dispatch({
      type: "connection",
      patch: { status: "disconnected", health: null, error: describeError(error) },
    });
    return false;
  }
  const results = await Promise.allSettled([
    client.me(signal),
    client.agents(signal),
    client.projects(signal),
  ]);
  const [me, agents, projects] = results;
  if (me.status === "fulfilled") store.dispatch({ type: "me", me: me.value });
  if (agents.status === "fulfilled") store.dispatch({ type: "agents", agents: agents.value });
  if (projects.status === "fulfilled") {
    store.dispatch({ type: "projects", projects: projects.value });
  }
  const firstFailure = results.find((r) => r.status === "rejected");
  if (firstFailure && firstFailure.status === "rejected") {
    store.dispatch({
      type: "connection",
      patch: { error: describeError(firstFailure.reason) },
    });
  }
  await refreshDesktopControl(client, store, signal);
  const humanId = store.getState().me?.id;
  if (humanId) {
    try {
      const inbox = await client.inbox(humanId, signal);
      store.dispatch({ type: "blockingCount", count: inbox.blockingCount });
    } catch {
      // the /events stream or the next poll will bring the count
    }
  }
  return true;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside <AppProvider>");
  return value;
}

export function useClient(): DaemonClient {
  return useApp().client;
}

/** The provider's stream options, for a page's own stream (a session's live log). */
export function useStreamOptions(): StreamOptions | undefined {
  return useApp().streamOptions;
}

/** The seams the voice panel's player uses (the same as the speech player's). */
export function useRealtime(): RealtimeSeams | undefined {
  return useApp().realtime;
}

export function useUiStore(): UiStore {
  return useApp().store;
}

export function useUiState<T>(selector: (state: UiState) => T): T {
  const { store } = useApp();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

/** Ids every chat and session call needs; null until /me and /agents answered. */
export function useIdentity(): { humanId: string; agentId: string } | null {
  const humanId = useUiState((s) => s.me?.id ?? null);
  const agentId = useUiState((s) => defaultAgent(s)?.id ?? null);
  return useMemo(() => (humanId && agentId ? { humanId, agentId } : null), [humanId, agentId]);
}

/**
 * Read desktop control's state from `GET /desktop/status` into the store (bootstrap, every
 * (re)opened stream, after a stop). A daemon without the desktop routes, or a failed read,
 * leaves the store as it is: the next frame or read corrects it.
 */
export async function refreshDesktopControl(
  client: DaemonClient,
  store: UiStore,
  signal?: AbortSignal,
): Promise<void> {
  // The read and the `/events` stream are two connections: a frame sent after the daemon
  // answered can arrive first. The token drops this answer if a frame (or a later read)
  // landed meanwhile, so a stale "off" never hides the banner of a burst already running.
  store.dispatch({ type: "desktopRead" });
  const readToken = store.getState().desktopOrder.next;
  try {
    const status = await client.desktopStatus(signal);
    store.dispatch({
      type: "desktopControl",
      desktopControl: desktopControlFromStatus(status),
      readToken,
    });
  } catch {
    // no desktop routes on this daemon, or unreachable for the moment
  }
}

/**
 * Read `/me` and `/agents` again (after a rename in Settings, or an `agent.changed` event,
 * U-025): every place that names the agent reads it from the store. Throws when a read fails;
 * what was read is kept.
 */
export async function refreshIdentity(client: DaemonClient, store: UiStore): Promise<void> {
  const [me, agents] = await Promise.allSettled([client.me(), client.agents()]);
  if (me.status === "fulfilled") store.dispatch({ type: "me", me: me.value });
  if (agents.status === "fulfilled") store.dispatch({ type: "agents", agents: agents.value });
  if (me.status === "rejected") throw me.reason;
  if (agents.status === "rejected") throw agents.reason;
}

/** Reload the project list (after a create, a transition, or a project.changed event). */
export async function refreshProjects(client: DaemonClient, store: UiStore): Promise<void> {
  const projects = await client.projects();
  store.dispatch({ type: "projects", projects });
}
