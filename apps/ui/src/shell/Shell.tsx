import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { describeError } from "../api/client.ts";
import { RunnerAutoUnlock } from "../components/RunnerAutoUnlock.tsx";
import { Badge, Button } from "../components/ui.tsx";
import { NewProjectDialog } from "../pages/NewProjectDialog.tsx";
import { useSetupGate } from "../pages/SetupPage.tsx";
import { useClient, useUiState, useUiStore } from "../store/context.tsx";
import { activeProject, type ThemePreference } from "../store/store.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { ConversationPanel } from "./ConversationPanel.tsx";
import { buildCommands } from "./commands.ts";
import { DesktopControlBanner } from "./DesktopControlBanner.tsx";
import { formatChord, useHotkeyBridge } from "./hotkey.ts";
import { ShellContext } from "./ShellContext.ts";
import { ShortcutsHelp } from "./ShortcutsHelp.tsx";
import { createSequenceMatcher, isEditableTarget } from "./shortcuts.ts";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/inbox", label: "Inbox", end: false },
  { to: "/memory", label: "Memory", end: false },
  { to: "/extensions", label: "Extensions", end: false },
  { to: "/changes", label: "Changes", end: false },
  { to: "/performance", label: "Performance", end: false },
  { to: "/updates", label: "Updates", end: false },
  { to: "/settings", label: "Settings", end: false },
];

/**
 * Always present: the desktop control banner while an agent controls the desktop, header with
 * the active project (click to switch), inbox badge, the kill switch, navigation (collapses
 * under 768px), the command palette, keyboard shortcuts and the conversation panel the desktop
 * shell's global hotkey opens (ADR 0064).
 */
export function Shell() {
  const client = useClient();
  const store = useUiStore();
  const navigate = useNavigate();
  const state = useUiState((s) => s);
  const active = activeProject(state);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  // The conversation (spec O.1): `request` counts voice requests (hotkey presses, the palette).
  const [conversation, setConversation] = useState({ open: false, request: 0 });
  const [hotkeyChord, setHotkeyChord] = useState<string | null>(null);
  const hotkey = useHotkeyBridge();
  // A fresh install opens the setup assistant first (ADR 0092).
  useSetupGate();

  const talk = useCallback(
    () => setConversation((c) => ({ open: true, request: c.request + 1 })),
    [],
  );

  // The desktop shell's global hotkey: a press shows the window (the shell does that) and
  // starts a voice turn here; the chord's label follows the shell's status.
  useEffect(() => {
    if (!hotkey.available) return;
    let active = true;
    const apply = (s: { chord: string; registered: boolean }) => {
      if (active) setHotkeyChord(s.registered ? s.chord : null);
    };
    hotkey.status().then(apply, () => {});
    const offChanged = hotkey.onChanged(apply);
    const offPress = hotkey.onPress((press) => {
      if (press.state === "pressed") talk();
    });
    return () => {
      active = false;
      offChanged();
      offPress();
    };
  }, [hotkey, talk]);
  const hotkeyLabel = hotkeyChord ? formatChord(hotkeyChord, state.config.platform) : null;

  const setTheme = useCallback(
    (theme: ThemePreference) => store.dispatch({ type: "theme", theme }),
    [store],
  );
  const setActiveProject = useCallback(
    (id: string) => store.dispatch({ type: "activeProject", id }),
    [store],
  );

  const toggleKill = useCallback(async () => {
    if (killBusy) return;
    setKillBusy(true);
    setKillError(null);
    try {
      const result = state.killActive
        ? await client.resume()
        : await client.kill({ scope: "all", reason: "stop all from the UI" });
      store.dispatch({ type: "killActive", active: result.killActive });
    } catch (error) {
      setKillError(describeError(error));
    } finally {
      setKillBusy(false);
    }
  }, [client, store, state.killActive, killBusy]);

  const commands = useMemo(
    () =>
      buildCommands({
        state,
        navigate,
        setActiveProject,
        setTheme,
        toggleKill: () => void toggleKill(),
        openNewProject: () => setNewProjectOpen(true),
        openShortcuts: () => setHelpOpen(true),
        openConversation: talk,
        hotkeyLabel,
      }),
    [state, navigate, setActiveProject, setTheme, toggleKill, talk, hotkeyLabel],
  );

  // Keyboard shortcuts: one matcher for the life of the shell.
  const matcher = useMemo(() => createSequenceMatcher(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = matcher.press({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        inField: isEditableTarget(e.target),
      });
      if (!id) return;
      switch (id) {
        case "palette":
          e.preventDefault();
          setPaletteOpen((o) => !o);
          break;
        case "escape":
          setPaletteOpen(false);
          setMenuOpen(false);
          setSwitcherOpen(false);
          break;
        case "help":
          e.preventDefault();
          setHelpOpen(true);
          break;
        case "go.home":
          navigate("/");
          break;
        case "go.inbox":
          navigate("/inbox");
          break;
        case "go.settings":
          navigate("/settings");
          break;
        case "go.memory":
          navigate("/memory");
          break;
        case "go.extensions":
          navigate("/extensions");
          break;
        case "go.changes":
          navigate("/changes");
          break;
        case "go.performance":
          navigate("/performance");
          break;
        case "go.updates":
          navigate("/updates");
          break;
        case "go.project":
          if (state.activeProjectId) {
            navigate(`/projects/${encodeURIComponent(state.activeProjectId)}`);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matcher, navigate, state.activeProjectId]);

  // Close the project switcher on an outside click.
  useEffect(() => {
    if (!switcherOpen) return;
    const onDown = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [switcherOpen]);

  const connection = state.connection;
  const connectionTone =
    connection.status === "connected"
      ? "good"
      : connection.status === "connecting"
        ? "warn"
        : "bad";
  const connectionLabel =
    connection.status === "connected"
      ? connection.streamMode === "polling"
        ? "connected (polling)"
        : "connected"
      : connection.status === "connecting"
        ? "connecting"
        : "not connected";

  const shellActions = useMemo(
    () => ({
      openNewProject: () => setNewProjectOpen(true),
      openPalette: () => setPaletteOpen(true),
      openShortcuts: () => setHelpOpen(true),
    }),
    [],
  );

  return (
    <ShellContext.Provider value={shellActions}>
      <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {/* Above everything, on every page, outside the scrolling main (spec S.32). */}
        <DesktopControlBanner />
        <header
          className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-2 md:gap-4 md:px-4 dark:border-neutral-800"
          data-testid="header"
        >
          <button
            type="button"
            className="rounded px-2 py-1 text-lg md:hidden"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            data-testid="menu-toggle"
          >
            ☰
          </button>
          <NavLink to="/" className="font-semibold">
            Forerunner
          </NavLink>

          <div className="relative" ref={switcherRef}>
            <button
              type="button"
              className="flex items-center gap-1 rounded bg-neutral-100 px-2 py-0.5 text-sm hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              data-testid="active-project"
              aria-haspopup="listbox"
              aria-expanded={switcherOpen}
              onClick={() => setSwitcherOpen((o) => !o)}
              title="Switch project"
            >
              {active ? active.name : "No active project"}
              <span aria-hidden className="text-xs">
                ▾
              </span>
            </button>
            {switcherOpen ? (
              <ul
                className="absolute left-0 z-30 mt-1 max-h-72 w-64 overflow-auto rounded border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
                data-testid="project-switcher"
              >
                {state.projects.length === 0 ? (
                  <li className="px-3 py-1.5 text-sm text-neutral-500">No projects yet.</li>
                ) : null}
                {state.projects.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                        p.id === state.activeProjectId ? "font-semibold" : ""
                      }`}
                      onClick={() => {
                        setActiveProject(p.id);
                        setSwitcherOpen(false);
                        navigate(`/projects/${encodeURIComponent(p.id)}`);
                      }}
                    >
                      <span>{p.name}</span>
                      <span className="text-xs text-neutral-500">{p.stage}</span>
                    </button>
                  </li>
                ))}
                <li className="border-t border-neutral-100 dark:border-neutral-800">
                  <button
                    type="button"
                    className="w-full px-3 py-1.5 text-left text-sm text-blue-700 hover:bg-neutral-100 dark:text-blue-300 dark:hover:bg-neutral-800"
                    onClick={() => {
                      setSwitcherOpen(false);
                      setNewProjectOpen(true);
                    }}
                  >
                    + New project
                  </button>
                </li>
              </ul>
            ) : null}
          </div>

          <nav
            className={`${menuOpen ? "flex" : "hidden"} w-full flex-col gap-1 md:flex md:w-auto md:flex-1 md:flex-row md:items-center md:gap-1`}
            aria-label="Main"
            data-testid="main-nav"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `rounded px-2 py-1 text-sm ${
                    isActive
                      ? "bg-neutral-200 font-medium dark:bg-neutral-800"
                      : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  }`
                }
              >
                {item.label}
                {item.to === "/inbox" && state.blockingCount > 0 ? (
                  <span
                    role="status"
                    className="ml-1 rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white"
                    data-testid="inbox-badge"
                    aria-label={`${state.blockingCount} blocking`}
                  >
                    {state.blockingCount}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Badge tone={connectionTone} testId="connection-status" title={connection.error ?? ""}>
              {connectionLabel}
            </Badge>
            <Button
              variant="ghost"
              onClick={() => setConversation((c) => ({ ...c, open: true }))}
              aria-label="Talk to your agent"
              title={hotkeyLabel ? `Talk to your agent (${hotkeyLabel})` : "Talk to your agent"}
              data-testid="talk-open"
            >
              Talk
            </Button>
            <Button
              variant="ghost"
              onClick={() => setPaletteOpen(true)}
              aria-label="Command palette"
              title="Command palette (Ctrl+K)"
              className="hidden md:inline-flex"
            >
              ⌘K
            </Button>
            <Button
              variant={state.killActive ? "primary" : "danger"}
              data-testid="kill-switch"
              aria-label={state.killActive ? "Resume all sessions" : "Stop all sessions"}
              onClick={() => void toggleKill()}
              disabled={killBusy}
            >
              {state.killActive ? "Resume" : "Stop all"}
            </Button>
          </div>
          {killError ? (
            <output
              className="w-full text-xs text-red-700 dark:text-red-300"
              data-testid="kill-error"
            >
              {killError}
            </output>
          ) : null}
          {state.killActive ? (
            <output
              className="w-full rounded bg-red-50 px-2 py-1 text-xs text-red-900 dark:bg-red-950 dark:text-red-200"
              data-testid="kill-banner"
            >
              Kill switch active: no session runs until you press Resume.
            </output>
          ) : null}
          {state.restart ? (
            <output
              className="w-full rounded bg-blue-50 px-2 py-1 text-xs text-blue-900 dark:bg-blue-950 dark:text-blue-200"
              data-testid="restart-banner"
            >
              {state.restart.reason === "setup" ? (
                "Restarting the background service to use your new keys. The app reconnects on its own."
              ) : (
                <>
                  Daemon restarting ({state.restart.reason}): {state.restart.fromVersion} →{" "}
                  {state.restart.targetVersion}. The app reconnects on its own.
                </>
              )}
            </output>
          ) : null}
        </header>
        <main className="flex-1 overflow-auto p-3 md:p-4">
          {connection.status === "disconnected" ? (
            <div
              role="alert"
              data-testid="not-connected"
              className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              Not connected to the Forerunner daemon at {state.config.baseUrl}
              {connection.error ? ` (${connection.error})` : ""}. Start the desktop app or{" "}
              <code>fr daemon</code>, then reload.
            </div>
          ) : null}
          {/* Cloud runner auto-unlock inside the window this computer set (ADR 0068). */}
          <RunnerAutoUnlock />
          <Outlet />
        </main>
        <CommandPalette
          open={paletteOpen}
          commands={commands}
          onClose={() => setPaletteOpen(false)}
        />
        <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
        <ConversationPanel
          open={conversation.open}
          onClose={() => setConversation((c) => ({ ...c, open: false }))}
          voiceRequest={conversation.request}
          chordLabel={hotkeyLabel}
        />
        <NewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
      </div>
    </ShellContext.Provider>
  );
}
