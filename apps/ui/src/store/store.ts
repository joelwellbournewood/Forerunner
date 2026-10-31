import type { AgentView, HealthView, HumanView, ProjectCard } from "../api/client.ts";
import type { DaemonConfig } from "../api/config.ts";
import type { DesktopIndicatorEventData, RestartRequested, StreamMode } from "../api/sse.ts";
import { type KeyValueStore, storageKey } from "../lib/storage.ts";
import { CHAT_HISTORY_LIMIT, type ChatMessage, loadChat, saveChat } from "./chat-history.ts";

/**
 * The one piece of app-wide state: projects, the active project, inbox count, daemon health,
 * theme. A plain reducer behind `subscribe`/`getSnapshot` so React reads it through
 * `useSyncExternalStore`; no external state library. Page-local data (a task list, a session
 * log) stays in the page.
 */

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type ThemePreference = "system" | "light" | "dark";
/** How the agent replies in the conversation panel's voice turns: spoken, or as text only. */
export type VoiceReplyMode = "voice" | "text";

export interface ConnectionState {
  status: ConnectionStatus;
  health: HealthView | null;
  /** Short text for the status line; null when fine. */
  error: string | null;
  streamMode: StreamMode;
  lastHeartbeatAt: string | null;
  /**
   * Bumped by "Retry" in the header (U-071): the provider reads the install-wide state again
   * and reopens the `/events` stream.
   */
  attempt: number;
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
  /** The conversation panel's "Reply: voice / text", remembered per install; default voice. */
  voiceReply: VoiceReplyMode;
  /** Set when the daemon announced a restart ("Update and restart"); cleared on reconnect. */
  restart: RestartRequested | null;
  /** Bumped on every `extension.changed` frame so the Extensions panel reloads. */
  extensionsVersion: number;
  /**
   * Desktop control's on-screen indicator (spec S.32): the latest `desktop.indicator` frame,
   * or the status view re-read when the stream (re)opens. The shell's banner shows while
   * `active`; null until the daemon said anything.
   */
  desktopControl: DesktopControlState | null;
  /**
   * The order of what set `desktopControl` (ADR 0067): every frame or fresh answer and every
   * status read started takes the next number; a read lands only when nothing that came
   * after it started (a frame, or a later read) has been applied, so a status read that was
   * answered before a newer frame never overwrites it.
   */
  desktopOrder: { next: number; applied: number };
  /**
   * Each project's Chat conversation (U-071), read from storage the first time the tab opens
   * (`chat.load`) and saved on every change, so a tab switch or a reload keeps it.
   */
  chats: Record<string, ChatMessage[]>;
}

/** What the desktop-control banner shows. */
export interface DesktopControlState {
  active: boolean;
  app: string | null;
  sessionId: string | null;
  agentId: string | null;
  since: string | null;
  /**
   * Desktop control was stopped (the banner, the tray or the revoke route) and refuses until
   * resumed: the banner offers "Resume". A revoke by the Extensions panel (the capability
   * disabled or removed) is not counted: the panel is where that is undone.
   */
  revoked: boolean;
}

/**
 * The controller's reason when the Extensions panel revoked it
 * (`DesktopController.attachExtensionRegistry`: "<name> disabled in the Extensions panel",
 * "<name> removed in the Extensions panel").
 */
const PANEL_REVOKE = /(disabled|removed) in the Extensions panel$/;

/** The store's state for a `GET /desktop/status` answer (bootstrap, a re-read, a stop). */
export function desktopControlFromStatus(status: {
  revoked: boolean;
  revokedReason: string | null;
  desktopControl: {
    active: boolean;
    app: string | null;
    sessionId: string | null;
    agentId: string | null;
    since: string | null;
  };
}): DesktopControlState {
  const c = status.desktopControl;
  return {
    active: c.active,
    app: c.active ? c.app : null,
    sessionId: c.active ? c.sessionId : null,
    agentId: c.active ? c.agentId : null,
    since: c.active ? c.since : null,
    revoked: status.revoked && !PANEL_REVOKE.test(status.revokedReason ?? ""),
  };
}

/** The store's state for one `desktop.indicator` frame; `revoked` is kept from before. */
export function desktopControlFromIndicator(
  data: DesktopIndicatorEventData,
  previous: DesktopControlState | null,
): DesktopControlState {
  return {
    active: data.on,
    app: data.on ? (data.app ?? null) : null,
    sessionId: data.on ? (data.sessionId ?? null) : null,
    agentId: data.on ? (data.agentId ?? null) : null,
    since: data.on ? (data.at ?? null) : null,
    revoked: data.on ? false : (previous?.revoked ?? false),
  };
}

export type UiAction =
  | { type: "connection"; patch: Partial<ConnectionState> }
  /** "Retry" in the header: connect again now (U-071). */
  | { type: "reconnect" }
  | { type: "me"; me: HumanView | null }
  | { type: "agents"; agents: AgentView[] }
  | { type: "projects"; projects: ProjectCard[] }
  | { type: "project.upsert"; project: ProjectCard }
  | { type: "activeProject"; id: string | null }
  | { type: "blockingCount"; count: number }
  | { type: "killActive"; active: boolean }
  | { type: "theme"; theme: ThemePreference }
  | { type: "voiceReply"; mode: VoiceReplyMode }
  | { type: "restart"; restart: RestartRequested | null }
  | { type: "extension.changed" }
  /**
   * A frame or a fresh answer (no `readToken`: always applied), or the answer of a status
   * read started with `desktopRead` (`readToken`: applied only if nothing newer landed).
   */
  | { type: "desktopControl"; desktopControl: DesktopControlState | null; readToken?: number }
  /** A status read starts: its token is `desktopOrder.next` after this action. */
  | { type: "desktopRead" }
  /** The Chat tab opens: its saved conversation is read once (U-071). */
  | { type: "chat.load"; projectId: string; messages?: ChatMessage[] }
  /** The conversation changed (a message sent, a token streamed, a reply ended). */
  | { type: "chat"; projectId: string; update: (messages: ChatMessage[]) => ChatMessage[] };

export const STORAGE_NAMES = {
  activeProject: "activeProject",
  theme: "theme",
  voiceReply: "voiceReply",
} as const;

function isTheme(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function initialState(config: DaemonConfig, storage: KeyValueStore): UiState {
  const storedTheme = storage.get(storageKey(config.installId, STORAGE_NAMES.theme));
  const storedReply = storage.get(storageKey(config.installId, STORAGE_NAMES.voiceReply));
  return {
    config,
    connection: {
      status: "connecting",
      health: null,
      error: null,
      streamMode: "closed",
      lastHeartbeatAt: null,
      attempt: 0,
    },
    me: null,
    agents: [],
    projects: [],
    projectsLoaded: false,
    activeProjectId: storage.get(storageKey(config.installId, STORAGE_NAMES.activeProject)),
    blockingCount: 0,
    killActive: false,
    theme: isTheme(storedTheme) ? storedTheme : "system",
    voiceReply: storedReply === "text" ? "text" : "voice",
    restart: null,
    extensionsVersion: 0,
    desktopControl: null,
    desktopOrder: { next: 0, applied: 0 },
    chats: {},
  };
}

export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: { ...state.connection, ...action.patch } };
    case "reconnect":
      return {
        ...state,
        connection: { ...state.connection, attempt: state.connection.attempt + 1 },
      };
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
    case "voiceReply":
      return state.voiceReply === action.mode ? state : { ...state, voiceReply: action.mode };
    case "restart":
      return { ...state, restart: action.restart };
    case "extension.changed":
      return { ...state, extensionsVersion: state.extensionsVersion + 1 };
    case "desktopControl": {
      const { next, applied } = state.desktopOrder;
      if (action.readToken !== undefined) {
        if (action.readToken <= applied) return state;
        return {
          ...state,
          desktopControl: action.desktopControl,
          desktopOrder: { next, applied: action.readToken },
        };
      }
      return {
        ...state,
        desktopControl: action.desktopControl,
        desktopOrder: { next: next + 1, applied: next + 1 },
      };
    }
    case "desktopRead":
      return {
        ...state,
        desktopOrder: { ...state.desktopOrder, next: state.desktopOrder.next + 1 },
      };
    case "chat.load":
      return state.chats[action.projectId]
        ? state
        : { ...state, chats: { ...state.chats, [action.projectId]: action.messages ?? [] } };
    case "chat": {
      const prev = state.chats[action.projectId] ?? [];
      const next = action.update(prev).slice(-CHAT_HISTORY_LIMIT);
      return { ...state, chats: { ...state.chats, [action.projectId]: next } };
    }
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
      // The saved conversation is read here, where the storage is (U-071).
      const resolved: UiAction =
        action.type === "chat.load" && !state.chats[action.projectId]
          ? { ...action, messages: loadChat(storage, config.installId, action.projectId) }
          : action;
      const next = reduce(state, resolved);
      if (next === state) return;
      if (action.type === "chat") {
        const before = state.chats[action.projectId] ?? [];
        const after = next.chats[action.projectId] ?? [];
        // Saved when a message is added or a reply ends, not on every streamed token.
        if (after.length !== before.length || !after.some((m) => m.streaming)) {
          saveChat(storage, config.installId, action.projectId, after);
        }
      }
      // Persist the per-install conveniences; everything else lives in the daemon.
      if (next.activeProjectId !== state.activeProjectId) {
        const key = storageKey(config.installId, STORAGE_NAMES.activeProject);
        if (next.activeProjectId) storage.set(key, next.activeProjectId);
        else storage.remove(key);
      }
      if (next.theme !== state.theme) {
        storage.set(storageKey(config.installId, STORAGE_NAMES.theme), next.theme);
      }
      if (next.voiceReply !== state.voiceReply) {
        storage.set(storageKey(config.installId, STORAGE_NAMES.voiceReply), next.voiceReply);
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

/**
 * The signed-in human's own principal agent (the one Settings -> Your agent renames, U-025);
 * null until `/me` and `/agents` answered, or when the human has none listed.
 */
export function ownPrincipal(state: UiState): AgentView | null {
  const humanId = state.me?.id;
  if (!humanId) return null;
  return state.agents.find((a) => a.ownerHumanId === humanId && a.kind === "principal") ?? null;
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
