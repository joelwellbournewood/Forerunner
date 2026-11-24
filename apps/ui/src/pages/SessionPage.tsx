import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  describeError,
  type EventView,
  type RunningView,
  type SessionTasksView,
  type SessionView,
} from "../api/client.ts";
import { type StreamMode, subscribeSessionEvents } from "../api/sse.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { ReadAloud } from "../components/ReadAloud.tsx";
import { EventText } from "../components/RichText.tsx";
import {
  Badge,
  Button,
  ErrorBanner,
  Loading,
  Money,
  SpendBar,
  statusTone,
} from "../components/ui.tsx";
import { currentFromLog, ENDED_SESSION } from "../lib/session-steps.ts";
import { formatTime } from "../lib/time.ts";
import { useClient, useStreamOptions, useUiState } from "../store/context.tsx";
import { StartSessionDialog } from "./project/StartSessionDialog.tsx";

type Level = EventView["level"];
const LEVELS: readonly Level[] = ["info", "warning", "escalation", "error"];
/**
 * L3-left-15: the level chips in a person's words (design §5 rule 6: no raw level names); a level
 * with no line has no chip (rule 5: no zero counts). It read "info (20) warning (0) escalation
 * (0) error (0)".
 */
const LEVEL_CHIP_WORDS: Readonly<Record<Level, string>> = {
  info: "Updates",
  warning: "Warnings",
  escalation: "Needs you",
  error: "Errors",
};

const LEVEL_STYLES: Record<Level, string> = {
  info: "",
  warning: "bg-amber-50 dark:bg-amber-950/40",
  escalation: "border-l-4 border-red-500 bg-red-50 font-medium dark:bg-red-950/40",
  error: "bg-red-100 dark:bg-red-950/60",
};

/** What a line's tone means, in words (W15B-15: its accessible name, never shown as text). */
const LEVEL_WORDS: Record<Exclude<Level, "info">, string> = {
  warning: "Worth a look",
  escalation: "Needs you",
  error: "Something went wrong",
};

const ACTIVE = new Set(["planned", "running", "paused"]);
/**
 * How often a working session's spend may read "Tasks in this session" again (d1109-sessions):
 * once a second, the stream's own pace, because the running task's CHF sits beside "Spent of
 * this session's budget" and the two must not disagree for longer than a glance (on the bench,
 * with 5 s, a one-task session read CHF 0.03 on the meter beside CHF 0.02 on its task).
 */
const TASKS_READ_MS = 1_000;
/** A session in one of these has ended: its log is complete and nothing more streams (U-071). */
export const ENDED = ENDED_SESSION;

/**
 * "14:05": when a session began, for its title (design §3.7), 24 hours as every time on the
 * screen (later #66: an en-US browser wrote "12:01 AM").
 */
export function startedAtWords(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatTime(iso);
}

/**
 * The stream badge in plain words (P7-4): "Live", "Updates every 5 s" while it polls,
 * "Connecting…"; nothing once the session ended (its status says so) or the stream closed.
 * Before: "finished", "live", "polling every 5 s" or the raw mode value.
 */
export function streamWords(mode: StreamMode, ended: boolean): string | null {
  if (ended) return null;
  switch (mode) {
    case "sse":
      return "Live";
    case "polling":
      return "Updates every 5 s";
    case "connecting":
      return "Connecting…";
    default:
      return null;
  }
}

/** A pull request a task of this session opened or updated, with its branch. */
export interface SessionPullRequest {
  taskTitle: string;
  url: string;
  number: number | null;
  branch: string | null;
}

/**
 * The pull requests the session's tasks went to, from the log (`task.files` carries the PR and
 * its branch, ADR 0106), each once, the last word on a task winning. Before (GitHub walk,
 * 2026-11-02) the session page named neither the PR nor the branch.
 */
export function pullRequestsFromLog(events: readonly EventView[]): SessionPullRequest[] {
  const titles = new Map<string, string>();
  const byUrl = new Map<string, SessionPullRequest>();
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const taskId = typeof p.taskId === "string" ? p.taskId : null;
    if (e.type === "task.started" && taskId && typeof p.title === "string")
      titles.set(taskId, p.title);
    if (e.type !== "task.files" || typeof p.prUrl !== "string" || !p.prUrl) continue;
    const n = /\/pulls?\/(\d+)\/?$/.exec(p.prUrl)?.[1];
    byUrl.set(p.prUrl, {
      taskTitle: (taskId && titles.get(taskId)) || "a task",
      url: p.prUrl,
      number: n ? Number(n) : null,
      // C-59 (polish-words): the number names the pull request; a branch without one is named
      // without its task-id part ("fr/1a2b3c4d-write-the-guide" reads "write-the-guide").
      branch:
        !n && typeof p.branch === "string" && p.branch
          ? p.branch.replace(/^fr\/[^/-]+-/, "")
          : null,
    });
  }
  return [...byUrl.values()];
}

/** Live session view (design §3.7, spec K.3). */
/**
 * Current task's words when no task's run is in flight, from the run indicator's entry for the
 * session (l4-starts-sessions, L4-money-208): its `what` with the first letter up ('The critic
 * checks "Write the README"', 'Plans the session', 'Picks the next task'); without an entry,
 * the bar's words for between tasks. `review`: the critic checks the task the log last ran.
 */
export function currentWords(run: Pick<RunningView, "state" | "what"> | null): {
  text: string;
  review: boolean;
} {
  const what = run && run.state !== "waiting" ? run.what.trim() : "";
  return {
    text: what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}` : "Picks the next task",
    review: run?.state === "reviewing",
  };
}

export function SessionPage() {
  const { id = "" } = useParams();
  const client = useClient();
  const streamOptions = useStreamOptions();
  const [session, setSession] = useState<SessionView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<StreamMode>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<Set<Level>>(new Set(LEVELS));
  /**
   * Design §3.7: the log shows person-level lines; Details adds the internal events in their own
   * words and the level filters. Their type names, numbers and payloads are behind a switch of
   * their own, "Show the raw events" (l3-small, run L3; live check 3, L3-run-12: Details showed
   * "#47 critic.session_review" and a JSON block with ids and USD micro-units).
   */
  const [details, setDetails] = useState(false);
  const [raw, setRaw] = useState(false);
  const showRaw = details && raw;
  const projectName = useUiState(
    (s) => s.projects.find((p) => p.id === session?.projectId)?.name ?? null,
  );
  // l4-starts-sessions (L4-money-208, D8): the run indicator's entry for this session, so
  // Current task says what the bar says (the critic checks "X", picks the next task).
  const runNow = useUiState((s) => s.running.find((r) => r.sessionId === id) ?? null);
  const [follow, setFollow] = useState(true);
  const [stopBusy, setStopBusy] = useState(false);
  /** Stop now asks once (design §3.7). */
  const [confirmStopNow, setConfirmStopNow] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const seenSeq = useRef(new Set<number>());
  /** "Tasks in this session" (d1109-sessions, U-086): each task it worked on, opening its drawer. */
  const [tasks, setTasks] = useState<SessionTasksView | null>(null);

  const appendEvents = useCallback((incoming: EventView[]) => {
    const fresh = incoming.filter((e) => !seenSeq.current.has(e.seq));
    if (fresh.length === 0) return;
    for (const e of fresh) seenSeq.current.add(e.seq);
    setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq));
  }, []);

  useEffect(() => {
    seenSeq.current = new Set();
    setEvents([]);
    setSession(null);
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    let sub: ReturnType<typeof subscribeSessionEvents> | null = null;
    (async () => {
      try {
        const [s, backlog] = await Promise.all([
          client.session(id, controller.signal),
          client.sessionEvents(id, 0, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setSession(s);
        appendEvents(backlog);
        setLoading(false);
        // A finished session's log is all there: the daemon ends its stream, so subscribing
        // would only reconnect and poll for good while the page said "connecting" (U-071).
        if (ENDED.has(s.status)) {
          setMode("closed");
          return;
        }
        let lastSeq = backlog.reduce((m, e) => Math.max(m, e.seq), 0);
        let ending = false;
        // The session ended while the page watched: read what is left of the log once, show
        // the final header, and stop the stream.
        const finish = async (ended?: SessionView) => {
          if (ending) return;
          ending = true;
          sub?.close();
          sub = null;
          setNotice(null);
          setMode("closed");
          try {
            const [last, rest] = await Promise.all([
              ended ? Promise.resolve(ended) : client.session(id, controller.signal),
              client.sessionEvents(id, lastSeq, controller.signal),
            ]);
            if (controller.signal.aborted) return;
            setSession(last);
            appendEvents(rest);
          } catch {
            // the header and log stay as they were; a reload reads them again
          }
        };
        sub = subscribeSessionEvents(
          client,
          id,
          {
            onEvent: (ev) => {
              if (controller.signal.aborted || ending) return;
              if (ev.event === "session.event" && ev.data.sessionId === id) {
                lastSeq = Math.max(lastSeq, ev.data.seq);
                appendEvents([ev.data]);
                if (ev.data.type === "session.ended") void finish();
              } else if (ev.event === "session.changed" && ev.data.id === id) {
                setSession(ev.data);
                if (ENDED.has(ev.data.status)) void finish(ev.data);
              }
            },
            onMode: (m) => {
              if (!ending) setMode(m);
            },
            onNotice: (n) => {
              if (!ending) setNotice(n);
            },
          },
          { ...streamOptions, afterSeq: lastSeq },
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(describeError(err));
        setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      sub?.close();
    };
  }, [client, id, appendEvents, streamOptions]);

  // The session's tasks, read again when a task starts or ends here, when the session ends, and
  // while it works when its spend moves (a model call of the running task was booked), at most
  // every TASKS_READ_MS, so the running task's CHF follows "Spent of this session's budget"
  // (W15-21's "CHF 0.00 until the run returns" on this page; d1109-sessions review).
  const tasksAbort = useRef<AbortController | null>(null);
  /** When the spend last read the tasks, and the spend the tasks were last read at. */
  const spendRead = useRef<{ at: number; chfMicro: number | null }>({ at: 0, chfMicro: null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session's page starts afresh
  useEffect(() => {
    const controller = new AbortController();
    tasksAbort.current = controller;
    spendRead.current = { at: 0, chfMicro: null };
    setTasks(null);
    return () => controller.abort();
  }, [id]);
  const readTasks = useCallback(() => {
    const signal = tasksAbort.current?.signal;
    return client
      .sessionTasks(id, signal)
      .then((t) => {
        if (!signal?.aborted) setTasks(t);
      })
      .catch(() => {
        // the section stays as it was; the log and the header still say what happened
      });
  }, [client, id]);
  const taskMoves = events.filter(
    (e) => e.type === "task.started" || e.type === "task.finished",
  ).length;
  const sessionStatus = session?.status ?? null;
  useEffect(() => {
    if (!sessionStatus) return;
    void taskMoves;
    void readTasks();
  }, [readTasks, sessionStatus, taskMoves]);
  const spentWhileWorking =
    session?.id === id && !ENDED.has(session.status) ? session.spent.chfMicro : null;
  useEffect(() => {
    if (spentWhileWorking === null) return;
    const was = spendRead.current;
    // The first figure is the one the tasks were first read at.
    if (was.chfMicro === null) {
      spendRead.current = { ...was, chfMicro: spentWhileWorking };
      return;
    }
    if (was.chfMicro === spentWhileWorking) return;
    const timer = setTimeout(
      () => {
        spendRead.current = { at: Date.now(), chfMicro: spentWhileWorking };
        void readTasks();
      },
      Math.max(0, was.at + TASKS_READ_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [spentWhileWorking, readTasks]);

  const shown = useMemo(
    () => (details ? events : events.filter((e) => e.audience === "person")),
    [events, details],
  );
  // The level filters live under Details: with Details off, a filter switched off there hides
  // nothing.
  const visible = useMemo(
    () => (details ? shown.filter((e) => filters.has(e.level)) : shown),
    [shown, filters, details],
  );
  const counts = useMemo(() => {
    const c: Record<Level, number> = { info: 0, warning: 0, escalation: 0, error: 0 };
    for (const e of shown) c[e.level] += 1;
    return c;
  }, [shown]);

  // Auto-scroll while following; a manual scroll up pauses it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new visible event
  useEffect(() => {
    if (!follow || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [visible.length, follow, details]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const toggleFilter = (level: Level) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

  // Stop after this task (the default) and Stop now (design §3.7, §4.9).
  const stop = async (how: "after_task" | "now") => {
    if (stopBusy) return;
    setStopBusy(true);
    try {
      const s =
        how === "now"
          ? await client.stopSession(id, "stopped from the live view")
          : await client.pauseSession(id);
      setSession(s);
      setConfirmStopNow(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setStopBusy(false);
    }
  };

  if (loading && !error) return <Loading what={`session ${id}`} />;
  if (error && !session) return <ErrorBanner message={error} />;
  if (!session) return null;

  const ended = ENDED.has(session.status);
  const stream = streamWords(mode, ended);
  const at = startedAtWords(session.startedAt);
  // Design §3.7: "Quote page · session at 14:05", never the session's id; a planning call's
  // page "Quote page · planning at 14:05" (d1109-sessions).
  const kind = session.planning ? "planning" : "session";
  const title = `${projectName ?? (session.planning ? "Planning" : "Session")}${at ? `${projectName ? ` · ${kind}` : ""} at ${at}` : ""}`;
  const live = ended ? null : currentFromLog(events);
  const pullRequests = pullRequestsFromLog(events);
  const current =
    live ??
    (session.currentTask && !ended
      ? { title: session.currentTask.title, specialist: session.currentTask.specialist, steps: [] }
      : null);
  // L4-money-208: no task in flight (planning, a review, between tasks) reads the bar's words;
  // live check 4 showed "Choosing the next task…" while the bar said the critic checks.
  const between = currentWords(runNow);

  return (
    <section aria-labelledby="session-title" className="flex h-full flex-col gap-3">
      <header className="space-y-2" data-testid="session-header">
        <div className="flex flex-wrap items-center gap-2">
          <h1 id="session-title" className="text-lg font-semibold" title={`session ${session.id}`}>
            {title}
          </h1>
          <Badge tone={statusTone(session.status)} testId="session-status">
            {session.statusText ?? session.status}
          </Badge>
          <span className="text-sm text-neutral-600 dark:text-neutral-400">
            {session.agentName}
          </span>
          {session.projectId ? (
            <Link
              to={`/projects/${encodeURIComponent(session.projectId)}`}
              className="text-sm text-blue-700 hover:underline dark:text-blue-300"
            >
              Open the project
            </Link>
          ) : null}
          {session.projectId ? (
            // d1109-sessions: the project's other sessions (ADR 0116).
            <Link
              to={`/projects/${encodeURIComponent(session.projectId)}/sessions`}
              className="text-sm text-blue-700 hover:underline dark:text-blue-300"
              data-testid="all-sessions"
            >
              All sessions
            </Link>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {stream ? (
              <Badge
                tone={mode === "sse" ? "good" : mode === "polling" ? "warn" : "neutral"}
                testId="stream-mode"
              >
                {stream}
              </Badge>
            ) : null}
            {session.status === "running" ? (
              <Button
                onClick={() => void stop("after_task")}
                disabled={stopBusy}
                data-testid="stop-after-task"
                title="Finishes the current task, then ends."
              >
                Stop after this task
              </Button>
            ) : null}
            {ended ? null : confirmStopNow ? (
              <span className="flex items-center gap-1" data-testid="stop-now-confirm">
                <span className="text-xs text-neutral-600 dark:text-neutral-400">
                  Stops the current task at once. It goes back to Ready; what it wrote so far stays
                  in the folder.
                </span>
                <Button
                  variant="danger"
                  onClick={() => void stop("now")}
                  disabled={stopBusy}
                  data-testid="stop-session"
                >
                  {stopBusy ? "Stopping…" : "Stop now"}
                </Button>
                <Button onClick={() => setConfirmStopNow(false)}>Keep going</Button>
              </span>
            ) : (
              <Button
                variant="danger"
                onClick={() => setConfirmStopNow(true)}
                disabled={stopBusy || !ACTIVE.has(session.status)}
                data-testid="stop-now"
                title="Stops the current task at once. It goes back to Ready; what it wrote so far stays in the folder."
              >
                Stop now
              </Button>
            )}
          </div>
        </div>
        {notice ? (
          <output className="block text-xs text-neutral-500" data-testid="stream-notice">
            {notice}
          </output>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {ended ? null : (
            <div className="rounded border border-neutral-200 p-2 text-sm md:col-span-2 dark:border-neutral-800">
              <div className="text-xs text-neutral-500">Current task</div>
              <div data-testid="current-task">
                {current && !between.review ? (
                  <>
                    <span className="font-medium">"{current.title}"</span>
                    {current.specialist ? (
                      <span className="text-neutral-600 dark:text-neutral-400">
                        {" "}
                        · {current.specialist}
                      </span>
                    ) : null}
                  </>
                ) : (
                  between.text
                )}
              </div>
              {current && !between.review && current.steps.length > 0 ? (
                <ul
                  className="mt-1 space-y-0.5 text-xs text-neutral-700 dark:text-neutral-300"
                  data-testid="current-steps"
                >
                  {current.steps.map((s) => (
                    <li key={s.seq}>{s.text}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          <div className="space-y-2 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800">
            <div className="flex justify-between text-xs text-neutral-500">
              <span>Steps</span>
              <span data-testid="steps">{session.steps}</span>
            </div>
            <SpendBar
              spent={session.spent}
              cap={session.budgetCap}
              label="Spent of this session's budget"
              testId="session-spend"
            />
            {/* C5-left-1, CS-6: the session moved to another credential: since when, why and
                what it spent on it (the daemon's words, from the ledger). */}
            {session.switchLine ? (
              <p
                className="text-xs text-neutral-600 dark:text-neutral-400"
                data-testid="session-switch-line"
              >
                {session.switchLine}
              </p>
            ) : null}
          </div>
        </div>
        {pullRequests.length > 0 ? (
          <div className="text-sm" data-testid="session-prs">
            <div className="text-xs text-neutral-500">Pull requests</div>
            <ul className="space-y-0.5">
              {pullRequests.map((pr) => (
                <li key={pr.url} data-testid="session-pr" className="flex flex-wrap gap-2">
                  <span>
                    "{pr.taskTitle}" · {pr.number ? `pull request #${pr.number}` : "pull request"}
                    {pr.branch ? ` · branch ${pr.branch}` : ""}
                  </span>
                  <ExternalLink href={pr.url} variant="inline" testId="session-pr-link">
                    Open
                  </ExternalLink>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {tasks && tasks.tasks.length > 0 ? (
          <section
            className="text-sm"
            data-testid="session-tasks"
            aria-labelledby="session-tasks-title"
          >
            <h2 id="session-tasks-title" className="text-xs text-neutral-500">
              Tasks in this session
            </h2>
            <ul className="space-y-0.5">
              {tasks.tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-baseline gap-2"
                  data-testid="session-task"
                >
                  <Link
                    to={`/projects/${encodeURIComponent(t.projectId)}/tasks?task=${encodeURIComponent(t.id)}`}
                    className="text-blue-700 hover:underline dark:text-blue-300"
                    data-testid="session-task-open"
                    title="Opens the task with its runs."
                  >
                    "{t.title}"
                  </Link>
                  <span data-testid="session-task-here">{t.here}</span>
                  {t.now ? (
                    <span
                      className="text-neutral-600 dark:text-neutral-400"
                      data-testid="session-task-now"
                    >
                      now: {t.now}
                    </span>
                  ) : null}
                  <span className="ml-auto text-neutral-500" data-testid="session-task-spent">
                    {t.spentWords}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {session.waitBlock ? (
          <WaitBlock
            session={session}
            block={session.waitBlock}
            onChanged={(next) => setSession(next)}
          />
        ) : null}
        {session.summary && session.summary !== "conversation" ? (
          <div className="flex flex-wrap items-start gap-2">
            <p
              className="flex-1 text-sm text-neutral-700 dark:text-neutral-300"
              data-testid="session-summary"
            >
              {session.summary}
            </p>
            <ReadAloud
              start={() => client.speakSession(id)}
              fallbackText={session.summary}
              testId="session-read-aloud"
            />
          </div>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {details ? <span className="text-neutral-500">Show:</span> : null}
        {(details ? LEVELS.filter((l) => counts[l] > 0 || !filters.has(l)) : []).map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={filters.has(level)}
            onClick={() => toggleFilter(level)}
            data-testid={`filter-${level}`}
            className={`rounded-full border px-2 py-0.5 text-xs ${
              filters.has(level)
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                : "border-neutral-300 text-neutral-500 dark:border-neutral-700"
            }`}
          >
            {LEVEL_CHIP_WORDS[level]} ({counts[level]})
          </button>
        ))}
        <label
          className="ml-auto flex items-center gap-1 text-xs"
          title="Also shows the internal steps: the brief, memory, each tool call, notifications."
        >
          <input
            type="checkbox"
            checked={details}
            onChange={(e) => setDetails(e.target.checked)}
            data-testid="details-toggle"
          />
          Details
        </label>
        {details ? (
          <label
            className="flex items-center gap-1 text-xs"
            title="The events as the app records them, for a bug report."
          >
            <input
              type="checkbox"
              checked={raw}
              onChange={(e) => setRaw(e.target.checked)}
              data-testid="raw-toggle"
            />
            Show the raw events
          </label>
        ) : null}
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
      </div>

      <div
        ref={logRef}
        onScroll={onScroll}
        className="event-log min-h-64 flex-1 overflow-auto rounded border border-neutral-200 font-mono text-xs dark:border-neutral-800"
        data-testid="event-log"
        aria-live="polite"
      >
        {visible.length === 0 ? (
          <p className="p-3 text-neutral-500" data-testid="event-log-empty">
            {shown.length > 0
              ? "Nothing matches the filters."
              : !ended
                ? "Waiting for the first event…"
                : // An ended session never waits (later #86: the planning session's only lines
                  // are internal ones); Details has them when there are any.
                  events.length > 0 && !details
                  ? "Nothing to show here. Details has the internal steps."
                  : "Nothing to show here."}
          </p>
        ) : null}
        <ol>
          {visible.map((e) => (
            <li
              key={e.id}
              className={`flex flex-col gap-0.5 border-b border-neutral-100 px-2 py-1 dark:border-neutral-900 ${LEVEL_STYLES[e.level]}`}
              data-testid="event-row"
              data-level={e.level}
              data-audience={e.audience}
              data-seq={e.seq}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-neutral-400">{formatTime(e.at)}</span>
                {showRaw ? (
                  <>
                    <span className="text-neutral-500">#{e.seq}</span>
                    <span className="text-neutral-500" data-testid="event-type">
                      {e.type}
                    </span>
                  </>
                ) : null}
                {e.level !== "info" ? (
                  // W15B-15: the tone by colour, named in words for a screen reader; never the
                  // raw level ("warning", "escalation", "error") as text on the line.
                  <span
                    role="img"
                    aria-label={LEVEL_WORDS[e.level]}
                    title={LEVEL_WORDS[e.level]}
                    data-testid="level-badge"
                    className={`inline-block h-2 w-2 shrink-0 self-center rounded-full ${
                      e.level === "warning" ? "bg-amber-500" : "bg-red-600"
                    }`}
                  />
                ) : null}
                <EventText type={e.type} text={e.text} className="font-sans text-sm" />
                {e.cost.chfMicro > 0 ? (
                  <Money value={e.cost} className="ml-auto text-neutral-500" />
                ) : null}
              </div>
              {e.changeId ? <ChangeUndo line={e} /> : null}
              {showRaw ? (
                <pre
                  className="overflow-auto rounded bg-neutral-100 p-1 text-[11px] dark:bg-neutral-900"
                  data-testid="event-raw"
                >
                  {JSON.stringify(e.payload, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * d1109-selftasks-chat (SC-6; the owner's D7: "each change shown with one Undo"): a change line
 * of the session (the agent's own fix of its task list, a change asked in chat) has its Undo
 * where it is shown; one whose Undo would not work says why in words instead. The click sends
 * POST /changes/:id/undo, as Changes does, and the line then reads the undo's sentence.
 */
function ChangeUndo({ line }: { line: EventView }) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const undo = async () => {
    if (busy || !line.changeId) return;
    setBusy(true);
    try {
      const r = await client.undoChange(line.changeId);
      setSaid(
        r.status === "done" || r.status === "partial"
          ? (r.sentence ?? "Undone.")
          : r.status === "pending"
            ? "The undo waits for your yes on Changes."
            : r.status === "cancelled"
              ? "Undo cancelled. Nothing changed."
              : `Not undone: ${(r.reason ?? "refused").replace(/[.\s]+$/, "")}.`,
      );
    } catch (err) {
      setSaid(`Not undone: ${describeError(err)}`);
    } finally {
      setBusy(false);
    }
  };
  if (said)
    return (
      <p className="text-xs text-neutral-600 dark:text-neutral-400" data-testid="change-undone">
        {said}
      </p>
    );
  // l4-chat-carried (L4-selftasks-129): read again (a reload), an undone line keeps the undo's
  // own sentence, as the click showed it.
  if (line.undone)
    return (
      <p className="text-xs text-neutral-500" data-testid="change-undone">
        {line.undoneSentence ?? "Undone."}
      </p>
    );
  if (line.undoable)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="px-2 py-0.5 text-xs"
          onClick={() => void undo()}
          disabled={busy}
          title="Takes back this change."
          data-testid="change-undo"
        >
          Undo
        </Button>
      </div>
    );
  return line.undoBlocked ? (
    <p className="text-xs text-neutral-500" data-testid="change-undo-blocked">
      Cannot be undone now: {line.undoBlocked.replace(/[.\s]+$/, "")}.
    </p>
  ) : null;
}

/**
 * d1109-run-visible (V-5; the owner's decision of 2026-11-09: the person's session goes on by
 * itself when its Claude credential is back, "shown ... with Cancel"): a session that ended to
 * wait says what comes next, in the daemon's words, with its one button: Cancel while it goes on
 * by itself (or a Start is kept for the reset), else Continue, which opens Start with the rest of
 * this session and what is left of its budget (POST /sessions with continues).
 */
function WaitBlock({
  session,
  block,
  onChanged,
}: {
  session: SessionView;
  block: NonNullable<SessionView["waitBlock"]>;
  onChanged: (next: SessionView) => void;
}) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.cancelContinuation(block.projectId);
      // A kept Start dropped: its tasks wait for the next Start (said once, as the Done lines).
      if (block.state === "starts_again") setNotice("Ready: it runs at your next Start.");
      onChanged(await client.session(session.id));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
      data-testid="session-wait"
      data-state={block.state}
    >
      <span className="flex-1" data-testid="session-wait-text">
        {notice ?? block.text}
      </span>
      {/* d1109-cred-screens (CS-7): while its ask card is open, Answer opens the card. */}
      {notice || !block.answer ? null : (
        <Link
          to={block.answer.to}
          className="rounded border border-amber-400 px-2 py-1 text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900"
          data-testid="session-wait-answer"
        >
          {block.answer.label}
        </Link>
      )}
      {notice ? null : block.action === "cancel" ? (
        <Button
          onClick={() => void cancel()}
          disabled={busy}
          title={block.explain}
          data-testid="session-wait-cancel"
        >
          Cancel
        </Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => setStarting(true)}
          title={block.explain}
          data-testid="session-wait-continue"
        >
          Continue
        </Button>
      )}
      {notice ? null : (
        <span className="w-full text-xs" data-testid="session-wait-explain">
          {block.explain}
        </span>
      )}
      {error ? <ErrorBanner message={error} /> : null}
      <StartSessionDialog
        open={starting}
        onClose={() => setStarting(false)}
        projectId={block.projectId}
        reference={block.budgetLeft}
        continues={{ sessionId: session.id, budget: block.budgetLeft }}
      />
    </div>
  );
}
