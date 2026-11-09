import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { describeError, type EventView, type SessionView } from "../api/client.ts";
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

type Level = EventView["level"];
const LEVELS: readonly Level[] = ["info", "warning", "escalation", "error"];

const LEVEL_STYLES: Record<Level, string> = {
  info: "",
  warning: "bg-amber-50 dark:bg-amber-950/40",
  escalation: "border-l-4 border-red-500 bg-red-50 font-medium dark:bg-red-950/40",
  error: "bg-red-100 dark:bg-red-950/60",
};

const ACTIVE = new Set(["planned", "running", "paused"]);
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
   * Design §3.7: the log shows person-level lines; Details adds the internal events, their
   * type names and numbers, the level filters and the raw payloads.
   */
  const [details, setDetails] = useState(false);
  const projectName = useUiState(
    (s) => s.projects.find((p) => p.id === session?.projectId)?.name ?? null,
  );
  const [follow, setFollow] = useState(true);
  const [stopBusy, setStopBusy] = useState(false);
  /** Stop now asks once (design §3.7). */
  const [confirmStopNow, setConfirmStopNow] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const seenSeq = useRef(new Set<number>());

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
  // Design §3.7: "Quote page · session at 14:05", never the session's id.
  const title = `${projectName ?? "Session"}${at ? `${projectName ? " · session" : ""} at ${at}` : ""}`;
  const live = ended ? null : currentFromLog(events);
  const pullRequests = pullRequestsFromLog(events);
  const current =
    live ??
    (session.currentTask && !ended
      ? { title: session.currentTask.title, specialist: session.currentTask.specialist, steps: [] }
      : null);

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
                {current ? (
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
                  "Choosing the next task…"
                )}
              </div>
              {current && current.steps.length > 0 ? (
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
        {(details ? LEVELS : []).map((level) => (
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
            {level} ({counts[level]})
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
                {details ? (
                  <>
                    <span className="text-neutral-500">#{e.seq}</span>
                    <span className="text-neutral-500" data-testid="event-type">
                      {e.type}
                    </span>
                  </>
                ) : null}
                {e.level !== "info" ? (
                  <Badge tone={e.level === "warning" ? "warn" : "bad"} testId="level-badge">
                    {e.level}
                  </Badge>
                ) : null}
                <EventText type={e.type} text={e.text} className="font-sans text-sm" />
                {e.cost.chfMicro > 0 ? (
                  <Money value={e.cost} className="ml-auto text-neutral-500" />
                ) : null}
              </div>
              {details ? (
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
