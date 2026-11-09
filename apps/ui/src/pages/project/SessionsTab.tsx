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
/** Rows a re-read asks for at a time once older pages are on screen (the daemon's most). */
const REREAD_PAGE = 50;

/**
 * What the tab shows: the first page (the count, the working rows, the chat line), the ended
 * rows on screen, and the cursor of the page after the last of them.
 */
interface Listed {
  first: ProjectSessionsView;
  rows: ProjectSessionRowView[];
  next: string | null;
}

/**
 * The oldest row an older page brought on screen and the cursor that page gave after it. The
 * daemon's cursor is a keyset on a session's start and id, which never change once it ended, so
 * the cursor after this row stays the way on however many sessions end meanwhile.
 */
interface ShownTo {
  id: string;
  next: string | null;
}

/**
 * Project: Sessions (the owner's decision D2 of 2026-11-09, design §3.11 proposed; ADR 0116):
 * look back on what each session did, spent and how it ended. The count, the working session on
 * top with what it does now (no Stop here: the session page and the header have it), one row per
 * session newest first that opens the session's page, older sessions a page at a time, and one
 * line for what chat about the project cost. No total, no ids, no raw states.
 *
 * A re-read never drops, shifts or repeats a row (ADR 0116 point 4): with older pages on screen
 * it reads on down to the oldest row shown, so a session that ends meanwhile joins the top and
 * pushes no row out of view, and every row on screen is read again, so each says what is true
 * now. Reads go one after the other, so a re-read and Show older sessions never cross.
 */
export function SessionsTab({ projectId, project }: { projectId: string; project?: ProjectCard }) {
  const client = useClient();
  const streamOptions = useStreamOptions();
  const now = useNow();
  const [listed, setListedState] = useState<Listed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const current = useRef<Listed | null>(null);
  const shownTo = useRef<ShownTo | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const rereadQueued = useRef(false);
  /** Changes with the project, so a read for the one before is never shown. */
  const generation = useRef(0);

  const setListed = useCallback((next: Listed) => {
    current.current = next;
    setListedState(next);
  }, []);

  /** Runs `op` once every read asked for before it is done. */
  const inTurn = useCallback((op: () => Promise<void>) => {
    const run = queue.current.then(op, op);
    queue.current = run.catch(() => {});
    return run;
  }, []);

  const reread = useCallback(
    (signal?: AbortSignal) => {
      // One re-read waiting its turn is enough: it reads everything when the turn comes.
      if (rereadQueued.current) return queue.current;
      rereadQueued.current = true;
      const gen = generation.current;
      return inTurn(async () => {
        rereadQueued.current = false;
        if (gen !== generation.current || signal?.aborted) return;
        try {
          const to = shownTo.current;
          const first = await client.projectSessions(
            projectId,
            to ? { limit: REREAD_PAGE } : undefined,
            signal,
          );
          let rows = first.rows;
          let next = first.next;
          if (to) {
            // Older pages are on screen: read on down to the oldest row shown.
            while (!rows.some((r) => r.id === to.id) && next) {
              const page = await client.projectSessions(
                projectId,
                { before: next, limit: REREAD_PAGE },
                signal,
              );
              rows = [...rows, ...page.rows];
              next = page.next;
            }
            const at = rows.findIndex((r) => r.id === to.id);
            if (at >= 0) {
              rows = rows.slice(0, at + 1);
              next = to.next;
            } else {
              // The oldest row shown left the list: show all it holds now.
              const last = rows[rows.length - 1];
              shownTo.current = last ? { id: last.id, next } : null;
            }
          }
          if (gen !== generation.current) return;
          setListed({ first, rows: unique(rows), next });
          setError(null);
        } catch (err) {
          if (signal?.aborted || gen !== generation.current) return;
          setError(describeError(err));
        }
      });
    },
    [client, projectId, inTurn, setListed],
  );

  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    shownTo.current = null;
    current.current = null;
    rereadQueued.current = false;
    setListedState(null);
    void reread(controller.signal);
    return () => controller.abort();
  }, [reread]);

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
    void reread();
  }, [version, reread]);

  // A working session's own frames move its row, at most every few seconds.
  const workingId = listed?.first.working[0]?.id ?? null;
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
        void reread();
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
  }, [client, workingId, reread, streamOptions]);

  const showOlder = () => {
    if (!current.current?.next || loadingOlder) return;
    setLoadingOlder(true);
    const gen = generation.current;
    void inTurn(async () => {
      try {
        // What is on screen when its turn comes: a re-read before it may have moved the end.
        const shown = current.current;
        if (!shown?.next || gen !== generation.current) return;
        const page = await client.projectSessions(projectId, { before: shown.next });
        if (gen !== generation.current) return;
        const last = page.rows[page.rows.length - 1];
        if (last) shownTo.current = { id: last.id, next: page.next };
        setListed({ ...shown, rows: unique([...shown.rows, ...page.rows]), next: page.next });
      } catch (err) {
        if (gen === generation.current) setError(describeError(err));
      } finally {
        setLoadingOlder(false);
      }
    });
  };

  const first = listed?.first ?? null;
  if (!first && !error) return <Loading what="sessions" />;
  if (!first) return <ErrorBanner message={error ?? ""} onRetry={() => void reread()} />;
  const rows = listed?.rows ?? [];
  const next = listed?.next ?? null;

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
          onClick={showOlder}
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

/** Each session once, in the order the daemon gave. */
function unique(rows: readonly ProjectSessionRowView[]): ProjectSessionRowView[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}
