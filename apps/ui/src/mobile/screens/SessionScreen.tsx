import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { EventView, SessionView } from "../../api/state-client.ts";
import { type SyncMode, subscribeStateSessionEvents } from "../../api/state-sse.ts";
import { Badge, Loading, SpendBar, statusTone } from "../../components/ui.tsx";
import { formatTime } from "../../lib/time.ts";
import { useMobileController } from "../store.tsx";

/** Watch a live session log from the phone (spec R.4) over the state service's session stream. */
export function SessionScreen() {
  const controller = useMobileController();
  const { id } = useParams();
  const [session, setSession] = useState<SessionView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [mode, setMode] = useState<SyncMode>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void controller.api
      .session(id)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    const sub = subscribeStateSessionEvents(
      controller.api,
      id,
      {
        onEvent: (event) => {
          if (event.event === "session.event") {
            setEvents((prev) =>
              prev.some((e) => e.seq === event.data.seq) ? prev : [...prev, event.data],
            );
          } else if (event.event === "session.changed") {
            setSession(event.data);
          }
        },
        onMode: setMode,
      },
      { live: controller.env.live, pollIntervalMs: controller.env.pollIntervalMs },
    );
    return () => {
      cancelled = true;
      sub.close();
    };
  }, [controller, id]);

  if (!id) return null;
  return (
    <section aria-labelledby="m-session-title" className="space-y-3">
      <div className="flex items-center gap-2">
        <h1 id="m-session-title" className="text-xl font-semibold">
          Live session
        </h1>
        <Badge tone={mode === "live" ? "good" : "warn"} testId="m-session-mode">
          {mode}
        </Badge>
        <Link
          to="/remote"
          className="ml-auto text-sm text-blue-700 hover:underline dark:text-blue-300"
        >
          Back
        </Link>
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {session ? (
        <div
          className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
          data-testid="m-session-header"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{session.agentName}</span>
            <Badge tone={statusTone(session.status)}>{session.status}</Badge>
            <span className="text-xs text-neutral-500">
              {session.steps}/{session.stepCap} steps
            </span>
          </div>
          <div className="mt-2">
            <SpendBar spent={session.spent} cap={session.budgetCap} />
          </div>
          {session.currentTask ? (
            <p className="mt-2 text-xs">
              Now: {session.currentTask.title} ({session.currentTask.specialist})
            </p>
          ) : null}
        </div>
      ) : (
        <Loading what="session" />
      )}
      <ol className="space-y-1 text-sm" data-testid="m-session-events">
        {events.map((e) => (
          <li
            key={e.seq}
            className={`rounded px-2 py-1 ${
              e.level === "escalation"
                ? "bg-amber-100 dark:bg-amber-900/40"
                : e.level === "error"
                  ? "bg-red-100 dark:bg-red-900/40"
                  : "bg-neutral-50 dark:bg-neutral-900"
            }`}
            data-level={e.level}
          >
            <span className="mr-2 text-xs text-neutral-500">{formatTime(e.at)}</span>
            {e.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
