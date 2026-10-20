import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { StateClient } from "../api/client.ts";
import type { WebConfig } from "../api/config.ts";
import { type FeedMode, type FeedOptions, subscribeChanges } from "../api/events.ts";
import type { ChangeEvent, ProjectCard } from "../api/types.ts";
import { browserClock, type Clock } from "../lib/clock.ts";
import { type Presence, pcPresence } from "../lib/presence.ts";
import type { KeyValueStore } from "../lib/storage.ts";

/**
 * What every screen shares once the page is signed in: the client, the project list with
 * the active project (always shown in the header, spec K.8), the blocking count for the
 * badge, the change feed and the PC presence that gates chat and the kill switch.
 */
export interface AppState {
  config: WebConfig;
  client: StateClient;
  clock: Clock;
  signOut(): void;
  projects: ProjectCard[];
  activeProjectId: string | null;
  setActiveProject(id: string): void;
  blockingCount: number;
  /** The inbox screen reports the count it just loaded, so the badge never waits for the feed. */
  reportBlockingCount(count: number): void;
  feedMode: FeedMode;
  /** Null until the first presence check answered. */
  presence: Presence | null;
  refreshPresence(): Promise<void>;
  /** A change event from the service; the unsubscribe is returned. */
  onChange(listener: (event: ChangeEvent) => void): () => void;
  /** A polling tick or a resync: reload what the screen shows. */
  onPoll(listener: () => void): () => void;
  /** A bootstrap problem in plain words, or null. */
  notice: string | null;
}

export const ACTIVE_PROJECT_KEY = "forerunner.approvals.activeProject";

const Context = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

export interface AppProviderProps {
  config: WebConfig;
  client: StateClient;
  storage: KeyValueStore;
  clock?: Clock;
  feedOptions?: FeedOptions;
  signOut: () => void;
  children: ReactNode;
}

const PRESENCE_EVENTS = new Set(["device.changed", "session.changed", "remote_command.changed"]);

export function AppProvider(props: AppProviderProps) {
  const { config, client, storage, signOut, feedOptions } = props;
  const clock = props.clock ?? browserClock;
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [blockingCount, setBlockingCount] = useState(0);
  const [feedMode, setFeedMode] = useState<FeedMode>("connecting");
  const [presence, setPresence] = useState<Presence | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const changeListeners = useRef(new Set<(e: ChangeEvent) => void>());
  const pollListeners = useRef(new Set<() => void>());
  const alive = useRef(true);

  const loadProjects = useCallback(async () => {
    const list = await client.projects();
    if (!alive.current) return;
    setProjects(list);
    setActiveProjectId((current) => {
      if (current && list.some((p) => p.id === current)) return current;
      const stored = storage.get(ACTIVE_PROJECT_KEY);
      const fromStore = stored ? list.find((p) => p.id === stored) : undefined;
      const blocked = list.find((p) => p.health === "blocked");
      return (fromStore ?? blocked ?? list[0])?.id ?? null;
    });
  }, [client, storage]);

  const loadBlocking = useCallback(async () => {
    const inbox = await client.inbox();
    if (alive.current) setBlockingCount(inbox.blockingCount);
  }, [client]);

  const refreshPresence = useCallback(async () => {
    const [devices, sessions, commands] = await Promise.all([
      client.devices(),
      client.sessions(["running", "paused"]),
      client.remoteCommands(20),
    ]);
    if (alive.current) setPresence(pcPresence({ devices, sessions, commands, now: clock.now() }));
  }, [client, clock]);

  const bootstrap = useCallback(async () => {
    const results = await Promise.allSettled([loadProjects(), loadBlocking(), refreshPresence()]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (alive.current) {
      setNotice(
        failed
          ? failed.reason instanceof Error
            ? failed.reason.message
            : "Could not load the page's data."
          : null,
      );
    }
  }, [loadProjects, loadBlocking, refreshPresence]);

  useEffect(() => {
    alive.current = true;
    void bootstrap();
    const feed = subscribeChanges(
      client,
      {
        onEvent: (event) => {
          for (const l of changeListeners.current) l(event);
          if (event.type === "human_request.changed") void loadBlocking().catch(() => undefined);
          if (event.type === "project.changed") void loadProjects().catch(() => undefined);
          if (PRESENCE_EVENTS.has(event.type)) void refreshPresence().catch(() => undefined);
        },
        onMode: (mode) => {
          setFeedMode(mode);
          // Anything that changed between the first loads and the stream opening is caught up now.
          if (mode === "live") {
            for (const l of pollListeners.current) l();
            void loadBlocking().catch(() => undefined);
          }
        },
        onPoll: () => {
          for (const l of pollListeners.current) l();
          void loadBlocking().catch(() => undefined);
          void refreshPresence().catch(() => undefined);
        },
        onResync: () => {
          for (const l of pollListeners.current) l();
          void bootstrap();
        },
      },
      feedOptions,
    );
    return () => {
      alive.current = false;
      feed.close();
    };
  }, [client, feedOptions, bootstrap, loadBlocking, loadProjects, refreshPresence]);

  const setActiveProject = useCallback(
    (id: string) => {
      setActiveProjectId(id);
      storage.set(ACTIVE_PROJECT_KEY, id);
    },
    [storage],
  );

  const reportBlockingCount = useCallback((count: number) => {
    setBlockingCount(count);
  }, []);

  const onChange = useCallback((listener: (e: ChangeEvent) => void) => {
    changeListeners.current.add(listener);
    return () => {
      changeListeners.current.delete(listener);
    };
  }, []);

  const onPoll = useCallback((listener: () => void) => {
    pollListeners.current.add(listener);
    return () => {
      pollListeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<AppState>(
    () => ({
      config,
      client,
      clock,
      signOut,
      projects,
      activeProjectId,
      setActiveProject,
      blockingCount,
      reportBlockingCount,
      feedMode,
      presence,
      refreshPresence,
      onChange,
      onPoll,
      notice,
    }),
    [
      config,
      client,
      clock,
      signOut,
      projects,
      activeProjectId,
      setActiveProject,
      blockingCount,
      reportBlockingCount,
      feedMode,
      presence,
      refreshPresence,
      onChange,
      onPoll,
      notice,
    ],
  );

  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}
