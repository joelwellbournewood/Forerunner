import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { describeError } from "../api/client.ts";
import { Button } from "../components/ui.tsx";
import {
  refreshProjects,
  useClient,
  useIdentity,
  useUiState,
  useUiStore,
} from "../store/context.tsx";

/**
 * The header's live parts (design §3.1): the stopped bar with Allow sessions again and Continue
 * where it stopped, the no-key bar, and the More menu of the screens a person does not use day to
 * day. What runs now, with Stop, is the run indicator's bar under the header (`RunIndicator.tsx`,
 * d1109-run-visible: it replaced the running chip and the header's Stop all).
 */

/** "2 min", "1 h 5 min": how long a session has run, from when it began. */
export function elapsedWords(since: string | null | undefined, now: number): string | null {
  if (!since) return null;
  const t = new Date(since).getTime();
  if (Number.isNaN(t)) return null;
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  if (min < 1) return "just started";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** A clock that ticks every 30 s while the component shows, for elapsed times. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/**
 * The stopped bar (design §3.1): "Sessions are stopped" with Allow sessions again (lets
 * sessions start again) and Continue where it stopped (allows them and starts a session again
 * on the projects whose sessions Stop all ended, as `POST /kill/resume` names them, each only
 * while its start check has work to run). Before (later #60), it started a session on every
 * project with work that could run, so stopping one project and pressing it started others.
 */
export function StoppedBar() {
  const client = useClient();
  const store = useUiStore();
  const identity = useIdentity();
  const killActive = useUiState((s) => s.killActive);
  const projects = useUiState((s) => s.projects);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!killActive) return null;
  const allow = async (continueWork: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.resume();
      store.dispatch({ type: "killActive", active: r.killActive });
      if (continueWork && identity) {
        // The projects Stop all stopped get a session again while there is work to run there
        // (their start check says so); the agent's starts run one after another, in order. An
        // older service names none: every project with work that can run, as before.
        const ids =
          r.stoppedProjects ?? (await client.projects().catch(() => projects)).map((p) => p.id);
        for (const id of ids) {
          const check = await client.startCheck(id).catch(() => null);
          // A wait for a credential's reset nobody kept yet still starts (TR-2): the Start is
          // kept for the reset and starts once then (d1109-starts-engine S-10).
          // D4: a task larger than the work budget is work too (`oversized`): the session takes it.
          if (
            !check ||
            (check.blocked && !check.blocked.startable) ||
            (!check.runnable.length && !check.oversized)
          )
            continue;
          await client.startSession({
            agentId: identity.agentId,
            projectId: id,
            trigger: "manual",
            reason: "continue where it stopped",
          });
        }
      }
      void refreshProjects(client, store).catch(() => {});
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="status"
      className="flex w-full flex-wrap items-center gap-2 rounded bg-red-50 px-2 py-1 text-sm text-red-900 dark:bg-red-950 dark:text-red-200"
      data-testid="kill-banner"
    >
      <span>Sessions are stopped. No session starts until you allow it again.</span>
      <Button
        onClick={() => void allow(false)}
        disabled={busy}
        data-testid="kill-resume"
        title="Lets sessions start again"
      >
        Allow sessions again
      </Button>
      <Button
        variant="primary"
        onClick={() => void allow(true)}
        disabled={busy}
        data-testid="kill-continue"
        title="Lets sessions start again and starts again the work Stop all stopped"
      >
        Continue where it stopped
      </Button>
      {error ? (
        <span className="text-red-700 dark:text-red-300" data-testid="kill-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Without a working Claude credential (`/me.provider` null), one bar says so (design §3.1):
 * planning and tasks need it; adding tasks does not. Not on `/setup`, where Connect points.
 */
export function NoKeyBar() {
  const provider = useUiState((s) => s.me?.provider);
  const { pathname } = useLocation();
  // Not on the page its Connect opens (later #63): the setup assistant says it there itself.
  if (provider !== null || pathname.startsWith("/setup")) return null;
  return (
    <div
      role="status"
      className="flex w-full flex-wrap items-center gap-2 rounded bg-amber-50 px-2 py-1 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      data-testid="no-key-bar"
    >
      <span>Claude is not connected: planning and tasks need it. You can still add tasks.</span>
      <Link
        to="/setup"
        className="font-medium text-blue-700 underline dark:text-blue-300"
        data-testid="no-key-connect"
      >
        Connect
      </Link>
    </div>
  );
}

/** The screens behind More (design §6): same routes, hidden from the bar, one click away. */
export const MORE_NAV = [
  { to: "/memory", label: "Memory" },
  { to: "/extensions", label: "Extensions" },
  { to: "/changes", label: "Changes" },
  { to: "/performance", label: "Performance" },
  { to: "/updates", label: "Updates" },
] as const;

export function MoreMenu({ onNavigate }: { onNavigate: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        className="rounded px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="more-nav"
      >
        More ▾
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 z-30 mt-1 flex w-44 flex-col rounded border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          data-testid="more-menu"
        >
          {MORE_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate();
              }}
              className="px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}
