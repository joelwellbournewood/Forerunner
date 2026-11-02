import { useEffect, useState } from "react";
import type { DaemonClient, EventView } from "../api/client.ts";
import { type StreamOptions, subscribeSessionEvents } from "../api/sse.ts";

/**
 * The step lines of the task a session runs, read from its log as it streams (design §3.7,
 * §3.5): the session page's Current task card and a running task's drawer both show them. A
 * `task.started` begins a task, its `task.step` lines follow ("read index.html", "ran node
 * --check: ok") and its `task.finished` ends it. The session row only says what ran at the end,
 * so both screens read the log.
 */

/** One step line of a task's run (`task.step`). */
export interface StepLine {
  seq: number;
  text: string;
}

/** The task a session works on now and its last step lines. */
export interface TaskInFlight {
  taskId: string | null;
  title: string;
  specialist: string | null;
  steps: StepLine[];
}

/** A session in one of these has ended: its log is complete and nothing more streams (U-071). */
export const ENDED_SESSION = new Set(["completed", "stopped", "failed", "killed"]);

/**
 * The task in flight and its last `max` step lines, or null between tasks and after the end.
 */
export function currentFromLog(events: readonly EventView[], max = 8): TaskInFlight | null {
  let current: TaskInFlight | null = null;
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === "task.started") {
      current = {
        taskId: typeof p.taskId === "string" ? p.taskId : null,
        title: typeof p.title === "string" ? p.title : "a task",
        specialist: typeof p.specialist === "string" ? p.specialist : null,
        steps: [],
      };
    } else if (e.type === "task.step" && current) {
      const text = typeof p.text === "string" && p.text ? p.text : e.text;
      current.steps = [...current.steps, { seq: e.seq, text }].slice(-max);
    } else if (e.type === "task.finished" || e.type === "session.ended") {
      current = null;
    }
  }
  return current;
}

/**
 * The last `max` step lines of `taskId`'s run while the session runs it, or null when the
 * session is not on that task (it finished, or the session moved on).
 */
export function taskStepsFromLog(
  events: readonly EventView[],
  taskId: string,
  max = 5,
): StepLine[] | null {
  const current = currentFromLog(events, max);
  return current && current.taskId === taskId ? current.steps : null;
}

/**
 * A session's log as it streams: the backlog first, then every new line, until the session
 * ends or `sessionId` is null. The same stream the session page reads (SSE, or polling where
 * the stream cannot open).
 */
export function useSessionLog(
  client: DaemonClient,
  sessionId: string | null,
  streamOptions?: StreamOptions,
): EventView[] {
  const [events, setEvents] = useState<EventView[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!sessionId) return;
    const controller = new AbortController();
    const seen = new Set<number>();
    let sub: ReturnType<typeof subscribeSessionEvents> | null = null;
    const add = (incoming: readonly EventView[]) => {
      const fresh = incoming.filter((e) => e.sessionId === sessionId && !seen.has(e.seq));
      if (!fresh.length || controller.signal.aborted) return;
      for (const e of fresh) seen.add(e.seq);
      setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq));
    };
    (async () => {
      const backlog = await client.sessionEvents(sessionId, 0, controller.signal);
      if (controller.signal.aborted) return;
      add(backlog);
      sub = subscribeSessionEvents(
        client,
        sessionId,
        {
          onEvent: (ev) => {
            if (controller.signal.aborted) return;
            if (ev.event === "session.event") {
              add([ev.data]);
              if (ev.data.type === "session.ended") sub?.close();
            } else if (
              ev.event === "session.changed" &&
              ev.data.id === sessionId &&
              ENDED_SESSION.has(ev.data.status)
            ) {
              sub?.close();
            }
          },
        },
        { ...streamOptions, afterSeq: backlog.reduce((m, e) => Math.max(m, e.seq), 0) },
      );
    })().catch(() => {
      // The lines are a convenience: the session page has the whole log.
    });
    return () => {
      controller.abort();
      sub?.close();
    };
  }, [client, sessionId, streamOptions]);
  return events;
}
