import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { describeError, type EventView, type SessionView } from "../api/client.ts";
import { type StreamMode, subscribeSessionEvents } from "../api/sse.ts";
import { ReadAloud } from "../components/ReadAloud.tsx";
import {
  Badge,
  Button,
  ErrorBanner,
  Loading,
  Money,
  SpendBar,
  statusTone,
} from "../components/ui.tsx";
import { formatTime } from "../lib/time.ts";
import { useClient } from "../store/context.tsx";

type Level = EventView["level"];
const LEVELS: readonly Level[] = ["info", "warning", "escalation", "error"];

const LEVEL_STYLES: Record<Level, string> = {
  info: "",
  warning: "bg-amber-50 dark:bg-amber-950/40",
  escalation: "border-l-4 border-red-500 bg-red-50 font-medium dark:bg-red-950/40",
  error: "bg-red-100 dark:bg-red-950/60",
};

const ACTIVE = new Set(["planned", "running", "paused"]);

/** Live session view (spec K.3). */
export function SessionPage() {
  const { id = "" } = useParams();
  const client = useClient();
  const [session, setSession] = useState<SessionView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<StreamMode>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<Set<Level>>(new Set(LEVELS));
  const [raw, setRaw] = useState(false);
  const [follow, setFollow] = useState(true);
  const [stopBusy, setStopBusy] = useState(false);
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
        const lastSeq = backlog.reduce((m, e) => Math.max(m, e.seq), 0);
        sub = subscribeSessionEvents(
          client,
          id,
          {
            onEvent: (ev) => {
              if (ev.event === "session.event" && ev.data.sessionId === id) appendEvents([ev.data]);
              else if (ev.event === "session.changed" && ev.data.id === id) setSession(ev.data);
            },
            onMode: setMode,
            onNotice: setNotice,
          },
          { afterSeq: lastSeq },
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
  }, [client, id, appendEvents]);

  const visible = useMemo(() => events.filter((e) => filters.has(e.level)), [events, filters]);
  const counts = useMemo(() => {
    const c: Record<Level, number> = { info: 0, warning: 0, escalation: 0, error: 0 };
    for (const e of events) c[e.level] += 1;
    return c;
  }, [events]);

  // Auto-scroll while following; a manual scroll up pauses it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new visible event
  useEffect(() => {
    if (!follow || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [visible.length, follow, raw]);

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

  const stop = async () => {
    if (stopBusy) return;
    setStopBusy(true);
    try {
      const s = await client.stopSession(id, "stopped from the live view");
      setSession(s);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setStopBusy(false);
    }
  };

  if (loading && !error) return <Loading what={`session ${id}`} />;
  if (error && !session) return <ErrorBanner message={error} />;
  if (!session) return null;

  const stepsPct =
    session.stepCap > 0 ? Math.min(100, Math.round((session.steps / session.stepCap) * 100)) : 0;

  return (
    <section aria-labelledby="session-title" className="flex h-full flex-col gap-3">
      <header className="space-y-2" data-testid="session-header">
        <div className="flex flex-wrap items-center gap-2">
          <h1 id="session-title" className="text-lg font-semibold">
            Session {session.id}
          </h1>
          <Badge tone={statusTone(session.status)} testId="session-status">
            {session.status}
          </Badge>
          <span className="text-sm text-neutral-600 dark:text-neutral-400">
            {session.agentName} · {session.trigger} · {session.runner}
          </span>
          {session.projectId ? (
            <Link
              to={`/projects/${encodeURIComponent(session.projectId)}`}
              className="text-sm text-blue-700 hover:underline dark:text-blue-300"
            >
              project
            </Link>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Badge
              tone={mode === "sse" ? "good" : mode === "polling" ? "warn" : "neutral"}
              testId="stream-mode"
            >
              {mode === "sse" ? "live" : mode === "polling" ? "polling every 5 s" : mode}
            </Badge>
            <Button
              variant="danger"
              onClick={() => void stop()}
              disabled={stopBusy || !ACTIVE.has(session.status)}
              data-testid="stop-session"
            >
              {stopBusy ? "Stopping…" : "Stop"}
            </Button>
          </div>
        </div>
        {notice ? (
          <output className="block text-xs text-neutral-500" data-testid="stream-notice">
            {notice}
          </output>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800">
            <div className="text-xs text-neutral-500">Current task</div>
            <div data-testid="current-task">
              {session.currentTask ? (
                <>
                  <span className="font-medium">{session.currentTask.title}</span>
                  <span className="text-neutral-600 dark:text-neutral-400">
                    {" "}
                    · {session.currentTask.specialist}
                  </span>
                </>
              ) : (
                "no task running"
              )}
            </div>
          </div>
          <div className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800">
            <div className="flex justify-between text-xs text-neutral-500">
              <span>Steps</span>
              <span data-testid="steps">
                {session.steps} / {session.stepCap}
              </span>
            </div>
            <div
              className="mt-1 h-2 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800"
              role="progressbar"
              aria-label="Steps"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={stepsPct}
            >
              <div className="h-full bg-blue-600" style={{ width: `${stepsPct}%` }} />
            </div>
          </div>
          <div className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800">
            <SpendBar
              spent={session.spent}
              cap={session.budgetCap}
              label="Spent vs cap"
              testId="session-spend"
            />
          </div>
        </div>
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
        <span className="text-neutral-500">Show:</span>
        {LEVELS.map((level) => (
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
        <label className="ml-auto flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={raw}
            onChange={(e) => setRaw(e.target.checked)}
            data-testid="raw-toggle"
          />
          Raw output
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
          <p className="p-3 text-neutral-500">
            {events.length === 0 ? "Waiting for the first event…" : "Nothing matches the filters."}
          </p>
        ) : null}
        <ol>
          {visible.map((e) => (
            <li
              key={e.id}
              className={`flex flex-col gap-0.5 border-b border-neutral-100 px-2 py-1 dark:border-neutral-900 ${LEVEL_STYLES[e.level]}`}
              data-testid="event-row"
              data-level={e.level}
              data-seq={e.seq}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-neutral-400">{formatTime(e.at)}</span>
                <span className="text-neutral-500">#{e.seq}</span>
                <span className="text-neutral-500">{e.type}</span>
                {e.level !== "info" ? (
                  <Badge tone={e.level === "warning" ? "warn" : "bad"} testId="level-badge">
                    {e.level}
                  </Badge>
                ) : null}
                <span className="whitespace-pre-wrap font-sans text-sm">{e.text}</span>
                {e.cost.chfMicro > 0 ? (
                  <Money value={e.cost} className="ml-auto text-neutral-500" />
                ) : null}
              </div>
              {raw ? (
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
