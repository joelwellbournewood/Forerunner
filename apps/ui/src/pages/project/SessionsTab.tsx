import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  describeError,
  type ProjectCard,
  type ProjectSessionRowView,
  type ProjectSessionsView,
} from "../../api/client.ts";
import { subscribeSessionEvents } from "../../api/sse.ts";
import { Button, ErrorBanner, Loading } from "../../components/ui.tsx";
import { durationWords, formatClock } from "../../lib/time.ts";
import { elapsedWords, useNow } from "../../shell/ShellBars.tsx";
import { useClient, useStreamOptions } from "../../store/context.tsx";

/** What the tab says while the project has no session (design §3.11, the empty state). */
export const NO_SESSIONS =
  "No sessions yet. Each session is listed here with what it did and what it cost.";

/** "4 sessions", "1 session": the heading is the count only, never a total of money. */
export function sessionsHeading(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

/**
 * A row's second line: when, how long, its task counts, how it ended and what it cost, and why
 * it started when the person did not press Start; each part only when it says something. A
 * working session says how long it has worked so far. Every word but the clock and the length
 * is the daemon's.
 */
export function sessionRowLine(row: ProjectSessionRowView, now = Date.now()): string {
  const when = row.startedAt ? formatClock(row.startedAt, now) : "";
  const long = row.working
    ? row.startedAt
      ? elapsedWords(row.startedAt, now)
      : ""
    : durationWords(row.durationMs);
  return [when, long, row.countsWords, row.endedWords, row.spentWords, row.startedBy]
    .filter((part): part is string => !!part)
    .join(" · ");
}

/** How often a working session's frames may re-read the list. */
const FRAME_READ_MS = 5_000;

/**
 * Project: Sessions (the owner's decision D2 of 2026-11-09, design §3.11 proposed; ADR 0116):
 * look back on what each session did, spent and how it ended. The count, the working session on
 * top with what it does now (no Stop here: the session page and the header have it), one row per
 * session newest first that opens the session's page, older sessions a page at a time, and one
 * line for what chat about the project cost. No total, no ids, no raw states.
 */
export function SessionsTab({ projectId, project }: { projectId: string; project?: ProjectCard }) {
  const client = useClient();
  const streamOptions = useStreamOptions();
  const now = useNow();
  const [first, setFirst] = useState<ProjectSessionsView | null>(null);
  const [older, setOlder] = useState<ProjectSessionRowView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadedOlder = useRef(false);

  const readFirst = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const page = await client.projectSessions(projectId, undefined, signal);
        setFirst(page);
        // A later page keeps its own cursor; the first page's is the way on until one is read.
        if (!loadedOlder.current) setNext(page.next);
        setError(null);
      } catch (err) {
        if (signal?.aborted) return;
        setError(describeError(err));
      }
    },
    [client, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadedOlder.current = false;
    setOlder([]);
    setFirst(null);
    void readFirst(controller.signal);
    return () => controller.abort();
  }, [readFirst]);

  // The project changed (a session started or ended, a task finished): read the list again.
  const version = project
    ? JSON.stringify([project.statusLine, project.progress, project.working?.sessionId ?? null])
    : "";
  const firstRead = useRef(true);
  useEffect(() => {
    if (!version) return;
    if (firstRead.current) {
      firstRead.current = false;
      return;
    }
    void readFirst();
  }, [version, readFirst]);

  // A working session's own frames move its row, at most every few seconds.
  const workingId = first?.working[0]?.id ?? null;
  useEffect(() => {
    if (!workingId) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      if (timer) return;
      const wait = Math.max(0, last + FRAME_READ_MS - Date.now());
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        void readFirst();
      }, wait);
    };
    const sub = subscribeSessionEvents(
      client,
      workingId,
      {
        onEvent: (ev) => {
          if (ev.event === "session.changed" || ev.event === "session.event") read();
        },
        onMode: () => {},
      },
      streamOptions,
    );
    return () => {
      sub.close();
      if (timer) clearTimeout(timer);
    };
  }, [client, workingId, readFirst, streamOptions]);

  const showOlder = async () => {
    if (!next || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await client.projectSessions(projectId, { before: next });
      loadedOlder.current = true;
      setOlder((prev) => [...prev, ...page.rows]);
      setNext(page.next);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  if (!first && !error) return <Loading what="sessions" />;
  if (!first) return <ErrorBanner message={error ?? ""} onRetry={() => void readFirst()} />;

  const seen = new Set<string>();
  const rows = [...first.rows, ...older].filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  return (
    <div className="space-y-4" data-testid="sessions-tab">
      {error ? <ErrorBanner message={error} /> : null}
      {first.count === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="sessions-empty">
          {NO_SESSIONS}
        </p>
      ) : (
        <h2 className="font-semibold" data-testid="sessions-heading">
          {sessionsHeading(first.count)}
        </h2>
      )}
      {first.working.length > 0 ? (
        <ul className="space-y-2" aria-label="Working now" data-testid="sessions-working">
          {first.working.map((row) => (
            <SessionRow key={row.id} row={row} now={now} working />
          ))}
        </ul>
      ) : null}
      {rows.length > 0 ? (
        <ul className="space-y-2" aria-label="Sessions" data-testid="sessions-list">
          {rows.map((row) => (
            <SessionRow key={row.id} row={row} now={now} />
          ))}
        </ul>
      ) : null}
      {next ? (
        <Button
          onClick={() => void showOlder()}
          disabled={loadingOlder}
          data-testid="sessions-older"
          title="Shows the sessions before these."
        >
          Show older sessions
        </Button>
      ) : null}
      {first.chat ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="sessions-chat">
          {first.chat.words}{" "}
          <Link
            to={`/projects/${encodeURIComponent(projectId)}/chat`}
            className="text-blue-700 hover:underline dark:text-blue-300"
            data-testid="sessions-chat-open"
          >
            Open Chat
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function SessionRow({
  row,
  now,
  working = false,
}: {
  row: ProjectSessionRowView;
  now: number;
  working?: boolean;
}) {
  return (
    <li>
      <Link
        to={`/sessions/${encodeURIComponent(row.id)}`}
        className={`block rounded border px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 ${
          working
            ? "border-blue-300 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/30"
            : "border-neutral-200 dark:border-neutral-800"
        }`}
        data-testid={working ? "session-row-working" : "session-row"}
      >
        <span className="flex items-center gap-2">
          {working ? (
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-600"
            />
          ) : null}
          <span
            className="font-medium text-neutral-900 dark:text-neutral-100"
            data-testid="session-row-gist"
          >
            {row.gist}
          </span>
        </span>
        <span
          className="mt-0.5 block text-xs text-neutral-600 dark:text-neutral-400"
          data-testid="session-row-line"
        >
          {sessionRowLine(row, now)}
        </span>
      </Link>
    </li>
  );
}
