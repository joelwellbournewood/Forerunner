import { CANCEL_WAIT_EXPLAIN } from "@forerunner/runtime/daemon/run-words";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { describeError, type RunningView } from "../api/client.ts";
import { Button } from "../components/ui.tsx";
import { refreshProjects, useClient, useUiState, useUiStore } from "../store/context.tsx";
import { elapsedWords, useNow } from "./ShellBars.tsx";

/**
 * The run indicator (d1109-run-visible, D8; the owner, 2026-11-09: "it should at least be very
 * clear to a user when a run is ongoing. That should also be very visually clear no matter where
 * the person is."): what runs now in the daemon's words (`GET /running`, `run.changed`), the same
 * element in three forms:
 *
 * - `bar`: directly under the header on every page and at every width, never inside the
 *   collapsed menu (the shell);
 * - `block`: Home's and the Overview's Working now (one project's entries with `projectId`);
 * - `compact`: the first line of the Talk panel, which covers the header.
 *
 * Each entry: a pulsing dot while work runs, the words (they open the session), how long it has
 * run, and Stop ▾ with Stop after this task, Stop now and Stop all (each Stop now and Stop all
 * asks once); a person's session that waits to go on after its credential wait shows its words
 * with Cancel instead, no dot. Nothing renders when nothing runs or waits.
 */

export type RunIndicatorForm = "bar" | "block" | "compact";

/** The Stop menu's choices in the design's words, with their one-line explanations. */
const STOP_AFTER = {
  label: "Stop after this task",
  explain: "Finishes the current task, then ends.",
} as const;
const STOP_NOW = {
  label: "Stop now",
  explain:
    "Stops the current task at once. It goes back to Ready; what it wrote so far stays in the folder.",
} as const;
const STOP_ALL = {
  label: "Stop all",
  explain: "Stops every running session now. No session starts until you allow it again.",
} as const;

/** Cancel on a session that waits to go on (V-2): what pressing it does, the daemon's words. */
export { CANCEL_WAIT_EXPLAIN };

/** The entries a form shows: one project's for the block form with `projectId`, else all. */
export function useRunning(projectId?: string | null): RunningView[] {
  const running = useUiState((s) => s.running);
  return projectId ? running.filter((r) => r.projectId === projectId) : running;
}

/** The window's title while a session runs ('● Quote page · Forerunner'), 'Forerunner' else. */
export function runTitle(running: readonly RunningView[]): string {
  const first = running.find((r) => r.state !== "waiting");
  return first ? `● ${first.projectName} · Forerunner` : "Forerunner";
}

export function RunIndicator({
  form = "bar",
  projectId,
  askStopAll = false,
  onAskStopAllDone,
}: {
  form?: RunIndicatorForm;
  /** The block form on a project's Overview: that project's entries only. */
  projectId?: string | null;
  /** The palette's Stop all opens this question (the shell holds it, later #59). */
  askStopAll?: boolean;
  onAskStopAllDone?: () => void;
}) {
  const running = useRunning(form === "block" ? projectId : null);
  const now = useNow();
  if (running.length === 0) return null;
  const wrap =
    form === "bar"
      ? "w-full border-b border-blue-200 bg-blue-50 px-3 py-1 text-sm text-blue-950 md:px-4 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-50"
      : form === "block"
        ? "space-y-1 rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-50"
        : "space-y-1 rounded bg-blue-50 px-2 py-1 text-xs text-blue-950 dark:bg-blue-950 dark:text-blue-50";
  return (
    <div
      role="status"
      aria-label="What runs now"
      className={wrap}
      data-testid={`run-indicator-${form}`}
    >
      {running.map((r, i) => (
        <RunEntry
          key={r.key}
          run={r}
          form={form}
          now={now}
          askStopAll={askStopAll && i === 0 && r.stop.includes("all")}
          onAskStopAllDone={onAskStopAllDone}
        />
      ))}
    </div>
  );
}

function RunEntry({
  run,
  form,
  now,
  askStopAll,
  onAskStopAllDone,
}: {
  run: RunningView;
  form: RunIndicatorForm;
  now: number;
  askStopAll: boolean;
  onAskStopAllDone?: () => void;
}) {
  const waiting = run.state === "waiting";
  const elapsed = waiting ? null : elapsedWords(run.since, now);
  const words = (
    <>
      {waiting ? null : (
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-600 dark:bg-blue-300"
        />
      )}
      <span className="min-w-0 break-words" data-testid="run-text">
        {run.text}
      </span>
    </>
  );
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="run-entry"
      data-state={run.state}
    >
      {run.sessionId ? (
        <Link
          to={`/sessions/${encodeURIComponent(run.sessionId)}`}
          className="flex min-w-0 items-center gap-2 font-medium hover:underline"
          data-testid="run-open"
          title={waiting ? "Open the session that waits" : "Open the running session"}
        >
          {words}
        </Link>
      ) : (
        <span className="flex min-w-0 items-center gap-2 font-medium">{words}</span>
      )}
      {elapsed ? (
        <span className="text-xs text-blue-800 dark:text-blue-200" data-testid="run-elapsed">
          {elapsed}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-2">
        {run.cancel && run.projectId ? (
          <CancelWait projectId={run.projectId} />
        ) : run.stop.length > 0 ? (
          <StopMenu
            run={run}
            compact={form === "compact"}
            askStopAll={askStopAll}
            onAskStopAllDone={onAskStopAllDone}
          />
        ) : null}
      </span>
    </div>
  );
}

/** Cancel on a session that waits to go on: nothing starts when Claude is back. */
function CancelWait({ projectId }: { projectId: string }) {
  const client = useClient();
  const store = useUiStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.cancelContinuation(projectId);
      store.dispatch({ type: "running", running: await client.running() });
      void refreshProjects(client, store).catch(() => {});
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-blue-800 dark:text-blue-200" data-testid="run-cancel-explain">
        {CANCEL_WAIT_EXPLAIN}
      </span>
      <Button
        onClick={() => void cancel()}
        disabled={busy}
        data-testid="run-cancel"
        title={CANCEL_WAIT_EXPLAIN}
      >
        Cancel
      </Button>
      {error ? (
        <span className="text-xs text-red-700 dark:text-red-300" data-testid="run-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

type Asking = null | "now" | "all";

/**
 * Stop ▾: Stop after this task (POST /sessions/:id/pause), Stop now (asks once, then POST
 * /sessions/:id/stop) and Stop all (asks once, then POST /kill). The open form's head names what
 * runs, with the monthly check's sentence of what it does.
 */
function StopMenu({
  run,
  compact,
  askStopAll,
  onAskStopAllDone,
}: {
  run: RunningView;
  compact: boolean;
  askStopAll: boolean;
  onAskStopAllDone?: () => void;
}) {
  const client = useClient();
  const store = useUiStore();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<Asking>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  // The palette's Stop all opens this question.
  useEffect(() => {
    if (askStopAll) {
      setOpen(true);
      setAsking("all");
    }
  }, [askStopAll]);
  // An outside click closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });
  const close = () => {
    setOpen(false);
    setAsking(null);
    setError(null);
    onAskStopAllDone?.();
  };
  const act = async (what: "after" | "now" | "all") => {
    setBusy(true);
    setError(null);
    try {
      if (what === "all") {
        const r = await client.kill({ scope: "all", reason: "stop all from the UI" });
        store.dispatch({ type: "killActive", active: r.killActive });
      } else if (run.sessionId) {
        if (what === "now") await client.stopSession(run.sessionId, "stopped from the run bar");
        else await client.pauseSession(run.sessionId);
      }
      close();
      store.dispatch({ type: "running", running: await client.running().catch(() => []) });
      void refreshProjects(client, store).catch(() => {});
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="relative" ref={ref}>
      <Button
        variant="danger"
        className={compact ? "px-2 py-0.5 text-xs" : ""}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="run-stop"
        title="Stop this session or every session"
      >
        Stop ▾
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="Stop"
          className="absolute right-0 z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] space-y-2 rounded border border-neutral-200 bg-white p-3 text-sm text-neutral-900 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          data-testid="run-stop-menu"
        >
          <p className="font-medium" data-testid="run-stop-head">
            {run.text}
          </p>
          {run.explain ? (
            <p className="text-xs text-neutral-600 dark:text-neutral-400" data-testid="run-explain">
              {run.explain}
            </p>
          ) : null}
          {asking === "now" ? (
            <Question
              text={STOP_NOW.explain}
              confirm="Stop now"
              busy={busy}
              testId="stop-now-confirm"
              confirmTestId="run-stop-now-confirm"
              onConfirm={() => void act("now")}
              onKeep={() => setAsking(null)}
            />
          ) : asking === "all" ? (
            <Question
              text={STOP_ALL.explain}
              confirm="Stop all"
              busy={busy}
              testId="kill-confirm"
              confirmTestId="kill-confirm-stop"
              onConfirm={() => void act("all")}
              onKeep={close}
            />
          ) : (
            <div className="flex flex-col gap-1">
              {run.stop.includes("after") ? (
                <MenuItem
                  label={STOP_AFTER.label}
                  explain={STOP_AFTER.explain}
                  testId="run-stop-after"
                  disabled={busy}
                  onClick={() => void act("after")}
                />
              ) : null}
              {run.stop.includes("now") ? (
                <MenuItem
                  label={STOP_NOW.label}
                  explain={STOP_NOW.explain}
                  testId="run-stop-now"
                  disabled={busy}
                  onClick={() => setAsking("now")}
                />
              ) : null}
              {run.stop.includes("all") ? (
                <MenuItem
                  label={STOP_ALL.label}
                  explain={STOP_ALL.explain}
                  testId="kill-switch"
                  disabled={busy}
                  onClick={() => setAsking("all")}
                />
              ) : null}
            </div>
          )}
          {error ? (
            <p className="text-xs text-red-700 dark:text-red-300" data-testid="kill-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

function MenuItem({
  label,
  explain,
  testId,
  disabled,
  onClick,
}: {
  label: string;
  explain: string;
  testId: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="rounded px-2 py-1 text-left hover:bg-neutral-100 disabled:opacity-60 dark:hover:bg-neutral-800"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      title={explain}
    >
      <span className="block font-medium">{label}</span>
      <span className="block text-xs text-neutral-600 dark:text-neutral-400">{explain}</span>
    </button>
  );
}

function Question({
  text,
  confirm,
  busy,
  testId,
  confirmTestId,
  onConfirm,
  onKeep,
}: {
  text: string;
  confirm: string;
  busy: boolean;
  testId: string;
  confirmTestId: string;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="space-y-2" role="dialog" aria-label={confirm} data-testid={testId}>
      <p>{text}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onKeep}>Keep going</Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy} data-testid={confirmTestId}>
          {busy ? "Stopping…" : confirm}
        </Button>
      </div>
    </div>
  );
}
