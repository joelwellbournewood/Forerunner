import type { NavigateFunction } from "react-router";
import type { ThemePreference, UiState } from "../store/store.ts";

/** One entry of the command palette. */
export interface Command {
  id: string;
  title: string;
  /** Secondary text, e.g. the shortcut or the project's stage. */
  hint?: string;
  group: "Navigate" | "Projects" | "Actions";
  run: () => void;
}

export interface CommandContext {
  state: UiState;
  navigate: NavigateFunction;
  setActiveProject: (id: string) => void;
  setTheme: (theme: ThemePreference) => void;
  toggleKill: () => void;
  openNewProject: () => void;
  openShortcuts: () => void;
  /** Opens the conversation and starts a push-to-talk turn (the global hotkey's action). */
  openConversation?: () => void;
  /** The global hotkey as it reads here, shown as the hint; null without one. */
  hotkeyLabel?: string | null;
}

export function buildCommands(ctx: CommandContext): Command[] {
  const { state, navigate } = ctx;
  const commands: Command[] = [
    {
      id: "nav.home",
      title: "Go to Home",
      hint: "g h",
      group: "Navigate",
      run: () => navigate("/"),
    },
    {
      id: "nav.inbox",
      title: "Go to Inbox",
      hint: state.blockingCount > 0 ? `${state.blockingCount} blocking · g i` : "g i",
      group: "Navigate",
      run: () => navigate("/inbox"),
    },
    {
      id: "nav.memory",
      title: "Go to Memory",
      hint: "g m",
      group: "Navigate",
      run: () => navigate("/memory"),
    },
    {
      id: "nav.extensions",
      title: "Go to Extensions",
      hint: "g e",
      group: "Navigate",
      run: () => navigate("/extensions"),
    },
    {
      id: "nav.changes",
      title: "Go to Changes (change log, undo)",
      hint: "g c",
      group: "Navigate",
      run: () => navigate("/changes"),
    },
    {
      id: "nav.performance",
      title: "Go to Performance (response times)",
      hint: "g t",
      group: "Navigate",
      run: () => navigate("/performance"),
    },
    {
      id: "nav.updates",
      title: "Go to Updates",
      hint: state.restart ? "restarting · g u" : "g u",
      group: "Navigate",
      run: () => navigate("/updates"),
    },
    {
      id: "nav.settings",
      title: "Go to Settings",
      hint: "g s",
      group: "Navigate",
      run: () => navigate("/settings"),
    },
  ];
  if (state.activeProjectId) {
    const id = state.activeProjectId;
    commands.push({
      id: "nav.project",
      title: "Open the active project",
      hint: "g p",
      group: "Navigate",
      run: () => navigate(`/projects/${encodeURIComponent(id)}`),
    });
  }
  for (const p of state.projects) {
    commands.push({
      id: `project.${p.id}`,
      title: `Switch project: ${p.name}`,
      hint: p.id === state.activeProjectId ? "active" : p.stage,
      group: "Projects",
      run: () => {
        ctx.setActiveProject(p.id);
        navigate(`/projects/${encodeURIComponent(p.id)}`);
      },
    });
  }
  if (ctx.openConversation) {
    commands.push({
      id: "action.talk",
      title: "Talk to your agent (voice or text)",
      hint: ctx.hotkeyLabel ?? undefined,
      group: "Actions",
      run: ctx.openConversation,
    });
  }
  commands.push(
    { id: "action.newProject", title: "New project", group: "Actions", run: ctx.openNewProject },
    {
      id: "action.kill",
      title: state.killActive ? "Resume all sessions" : "Stop all sessions",
      group: "Actions",
      run: ctx.toggleKill,
    },
    {
      id: "action.theme.dark",
      title: "Theme: dark",
      hint: state.theme === "dark" ? "current" : undefined,
      group: "Actions",
      run: () => ctx.setTheme("dark"),
    },
    {
      id: "action.theme.light",
      title: "Theme: light",
      hint: state.theme === "light" ? "current" : undefined,
      group: "Actions",
      run: () => ctx.setTheme("light"),
    },
    {
      id: "action.theme.system",
      title: "Theme: follow the system",
      hint: state.theme === "system" ? "current" : undefined,
      group: "Actions",
      run: () => ctx.setTheme("system"),
    },
    {
      id: "action.shortcuts",
      title: "Keyboard shortcuts",
      hint: "?",
      group: "Actions",
      run: ctx.openShortcuts,
    },
  );
  return commands;
}

/** Case-insensitive subsequence-free filter: every word of the query must appear. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  return commands.filter((c) => {
    const hay = `${c.title} ${c.hint ?? ""} ${c.group}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
