import type { AgentView, HealthView, HumanView, ProjectCard } from "../api/client.ts";
import type { DaemonConfig } from "../api/config.ts";
import type { RestartRequested, StreamMode } from "../api/sse.ts";
import { type KeyValueStore, storageKey } from "../lib/storage.ts";

/**
 * The one piece of app-wide state: projects, the active project, inbox count, daemon health,
 * theme. A plain reducer behind `subscribe`/`getSnapshot` so React reads it through
 * `useSyncExternalStore`; no external state library. Page-local data (a task list, a session
 * log) stays in the page.
 */

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type ThemePreference = "system" | "light" | "dark";

export interface ConnectionState {
  status: ConnectionStatus;
  health: HealthView | null;
  /** Short text for the status line; null when fine. */
  error: string | null;
  streamMode: StreamMode;
  lastHeartbeatAt: string | null;
}

export interface UiState {
  config: DaemonConfig;
  connection: ConnectionState;
  me: HumanView | null;
  agents: AgentView[];
  projects: ProjectCard[];
  projectsLoaded: boolean;
  activeProjectId: string | null;
  blockingCount: number;
  killActive: boolean;
  theme: ThemePreference;
  /** Set when the daemon announced a restart ("Update and restart"); cleared on reconnect. */
  restart: RestartRequested | null;
  /** Bumped on every `extension.changed` frame so the Extensions panel reloads. */
  extensionsVersion: number;
}

export type UiAction =
  | { type: "connection"; patch: Partial<ConnectionState> }
  | { type: "me"; me: HumanView | null }
  | { type: "agents"; agents: AgentView[] }
  | { type: "projects"; projects: ProjectCard[] }
  | { type: "project.upsert"; project: ProjectCard }
  | { type: "activeProject"; id: string | null }
  | { type: "blockingCount"; count: number }
  | { type: "killActive"; active: boolean }
  | { type: "theme"; theme: ThemePreference }
  | { type: "restart"; restart: RestartRequested | null }
  | { type: "extension.changed" };

export const STORAGE_NAMES = { activeProject: "activeProject", theme: "theme" } as const;

function isTheme(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function initialState(config: DaemonConfig, storage: KeyValueStore): UiState {
  const storedTheme = storage.get(storageKey(config.installId, STORAGE_NAMES.theme));
  return {
    config,
    connection: {
      status: "connecting",
      health: null,
      error: null,
      streamMode: "closed",
      lastHeartbeatAt: null,
    },
    me: null,
    agents: [],
    projects: [],
    projectsLoaded: false,
    activeProjectId: storage.get(storageKey(config.installId, STORAGE_NAMES.activeProject)),
    blockingCount: 0,
    killActive: false,
    theme: isTheme(storedTheme) ? storedTheme : "system",
    restart: null,
    extensionsVersion: 0,
  };
}

export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: { ...state.connection, ...action.patch } };
    case "me":
      return { ...state, me: action.me };
    case "agents":
      return { ...state, agents: action.agents };
    case "projects": {
      const projects = action.projects;
      let activeProjectId = state.activeProjectId;
      const stillThere = activeProjectId && projects.some((p) => p.id === activeProjectId);
      if (!stillThere) {
        activeProjectId = projects.find((p) => p.active)?.id ?? projects[0]?.id ?? null;
      }
      return { ...state, projects, projectsLoaded: true, activeProjectId };
    }
    case "project.upsert": {
      const exists = state.projects.some((p) => p.id === action.project.id);
      const projects = exists
        ? state.projects.map((p) => (p.id === action.project.id ? action.project : p))
        : [...state.projects, action.project];
      return { ...state, projects };
    }
    case "activeProject":
      return state.activeProjectId === action.id ? state : { ...state, activeProjectId: action.id };
    case "blockingCount":
      return state.blockingCount === action.count
        ? state
        : { ...state, blockingCount: action.count };
    case "killActive":
      return state.killActive === action.active ? state : { ...state, killActive: action.active };
    case "theme":
      return state.theme === action.theme ? state : { ...state, theme: action.theme };
    case "restart":
      return { ...state, restart: action.restart };
    case "extension.changed":
      return { ...state, extensionsVersion: state.extensionsVersion + 1 };
    default:
      return state;
  }
}

export interface UiStore {
  getState(): UiState;
  subscribe(listener: () => void): () => void;
  dispatch(action: UiAction): void;
}

export function createStore(config: DaemonConfig, storage: KeyValueStore): UiStore {
  let state = initialState(config, storage);
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      // Persist the per-install conveniences; everything else lives in the daemon.
      if (next.activeProjectId !== state.activeProjectId) {
        const key = storageKey(config.installId, STORAGE_NAMES.activeProject);
        if (next.activeProjectId) storage.set(key, next.activeProjectId);
        else storage.remove(key);
      }
      if (next.theme !== state.theme) {
        storage.set(storageKey(config.installId, STORAGE_NAMES.theme), next.theme);
      }
      state = next;
      for (const l of listeners) l();
    },
  };
}

/** The project shown in the header, or null. */
export function activeProject(state: UiState): ProjectCard | null {
  return state.projects.find((p) => p.id === state.activeProjectId) ?? null;
}

/** The agent chat and sessions use: the human's principal, else the first listed. */
export function defaultAgent(state: UiState): AgentView | null {
  const mine = state.me
    ? state.agents.find((a) => a.ownerHumanId === state.me?.id && a.kind === "principal")
    : undefined;
  return (
    mine ?? state.agents.find((a) => a.ownerHumanId === state.me?.id) ?? state.agents[0] ?? null
  );
}
