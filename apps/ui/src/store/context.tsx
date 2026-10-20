import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { type DaemonClient, describeError } from "../api/client.ts";
import { type StreamSubscription, subscribeDaemonEvents } from "../api/sse.ts";
import { defaultAgent, type UiState, type UiStore } from "./store.ts";
import { applyTheme, watchSystemTheme } from "./theme.ts";

interface AppContextValue {
  client: DaemonClient;
  store: UiStore;
}

const AppContext = createContext<AppContextValue | null>(null);

export interface AppProviderProps {
  client: DaemonClient;
  store: UiStore;
  /** Load health, me, agents, projects, inbox on mount and open the /events stream. */
  bootstrap?: boolean;
  children: ReactNode;
}

export function AppProvider({ client, store, bootstrap = true, children }: AppProviderProps) {
  useEffect(() => {
    if (!bootstrap) return;
    const controller = new AbortController();
    let stream: StreamSubscription | null = null;
    void bootstrapStore(client, store, controller.signal).then((ok) => {
      if (!ok || controller.signal.aborted) return;
      const me = store.getState().me;
      if (!me) return;
      stream = subscribeDaemonEvents(client, me.id, {
        onEvent: (event) => {
          if (event.event === "inbox.changed") {
            store.dispatch({ type: "blockingCount", count: event.data.blockingCount });
          } else if (event.event === "project.changed") {
            void client
              .project(event.data.id)
              .then((project) => store.dispatch({ type: "project.upsert", project }))
              .catch(() => {});
          } else if (event.event === "heartbeat") {
            store.dispatch({
              type: "connection",
              patch: { lastHeartbeatAt: event.data.at, status: "connected", error: null },
            });
          }
        },
        onMode: (mode) => store.dispatch({ type: "connection", patch: { streamMode: mode } }),
      });
    });
    return () => {
      controller.abort();
      stream?.close();
    };
  }, [client, store, bootstrap]);

  useEffect(() => {
    applyTheme(store.getState().theme);
    const unsubscribeStore = store.subscribe(() => applyTheme(store.getState().theme));
    const unsubscribeSystem = watchSystemTheme(() => applyTheme(store.getState().theme));
    return () => {
      unsubscribeStore();
      unsubscribeSystem();
    };
  }, [store]);

  return <AppContext.Provider value={{ client, store }}>{children}</AppContext.Provider>;
}

/** Fetch the install-wide state once; returns false when the daemon cannot be reached. */
export async function bootstrapStore(
  client: DaemonClient,
  store: UiStore,
  signal?: AbortSignal,
): Promise<boolean> {
  store.dispatch({ type: "connection", patch: { status: "connecting", error: null } });
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

/** Reload the project list (after a create, a transition, or a project.changed event). */
export async function refreshProjects(client: DaemonClient, store: UiStore): Promise<void> {
  const projects = await client.projects();
  store.dispatch({ type: "projects", projects });
}
