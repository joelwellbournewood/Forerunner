import { useCallback, useState } from "react";
import { Link } from "react-router";
import { type DesktopStatusView, describeError } from "../api/client.ts";
import { useClient, useUiState, useUiStore } from "../store/context.tsx";
import { desktopControlFromStatus } from "../store/store.ts";

/**
 * Desktop control's on-screen indicator in the app (spec S.32; ADR 0067): a full-width,
 * high-contrast banner at the very top of the window, above the header, on every page, while
 * the latest `desktop.indicator` frame (or the status view re-read on reconnect) says desktop
 * control is active. It names the agent, the application and the session, and "Stop desktop
 * control" calls `POST /desktop/revoke`, which interrupts the action in flight, drops the
 * queued ones and refuses further desktop actions until resumed. After a stop a quieter line
 * says so and offers "Resume desktop control" (`POST /desktop/resume`).
 */
export function DesktopControlBanner() {
  const client = useClient();
  const store = useUiStore();
  const control = useUiState((s) => s.desktopControl);
  const agents = useUiState((s) => s.agents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The daemon's answer to the stop or resume is fresh: applied like a frame.
  const apply = useCallback(
    (status: DesktopStatusView) =>
      store.dispatch({ type: "desktopControl", desktopControl: desktopControlFromStatus(status) }),
    [store],
  );

  const stop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const report = await client.desktopRevoke("stopped from the desktop control banner");
      apply(report.status);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [busy, client, apply]);

  const resume = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      apply(await client.desktopResume());
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [busy, client, apply]);

  if (!control) return null;

  if (control.active) {
    const agentName = control.agentId
      ? (agents.find((a) => a.id === control.agentId)?.name ?? control.agentId)
      : "An agent";
    return (
      <div
        role="alert"
        aria-live="assertive"
        data-testid="desktop-control-banner"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b-4 border-yellow-300 bg-red-700 px-3 py-2 text-sm font-semibold text-white md:px-4"
      >
        <span aria-hidden className="text-lg leading-none">
          ●
        </span>
        <span className="uppercase tracking-wide">Desktop control active</span>
        <span className="font-normal" data-testid="desktop-control-what">
          <span data-testid="desktop-control-agent">{agentName}</span> is controlling{" "}
          <strong data-testid="desktop-control-app">{control.app ?? "the desktop"}</strong>
          {control.sessionId ? (
            <>
              {" "}
              in session{" "}
              <Link
                to={`/sessions/${encodeURIComponent(control.sessionId)}`}
                className="font-semibold underline"
                data-testid="desktop-control-session"
              >
                {control.sessionId}
              </Link>
            </>
          ) : null}
          .
        </span>
        <button
          type="button"
          className="ml-auto rounded bg-white px-3 py-1 text-sm font-bold text-red-800 hover:bg-yellow-100 disabled:opacity-60"
          data-testid="desktop-control-stop"
          onClick={() => void stop()}
          disabled={busy}
        >
          {busy ? "Stopping…" : "Stop desktop control"}
        </button>
        {error ? (
          <output className="w-full text-xs font-normal" data-testid="desktop-control-error">
            Stop failed: {error}. Use "Stop all" or the tray's kill switch.
          </output>
        ) : null}
      </div>
    );
  }

  if (control.revoked) {
    return (
      <div
        data-testid="desktop-control-stopped"
        className="flex flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-900 md:px-4 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      >
        <span>Desktop control is stopped: no agent can use the desktop until you resume it.</span>
        <button
          type="button"
          className="rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 disabled:opacity-60 dark:hover:bg-amber-900"
          data-testid="desktop-control-resume"
          onClick={() => void resume()}
          disabled={busy}
        >
          Resume desktop control
        </button>
        {error ? (
          <output className="w-full" data-testid="desktop-control-error">
            {error}
          </output>
        ) : null}
      </div>
    );
  }

  return null;
}
