import { type FormEvent, useState } from "react";
import { describeError } from "../../api/client.ts";
import { QUEUE_KINDS, type QueueItemView } from "../../api/contracts.ts";
import { RouteMissing } from "../../components/RouteMissing.tsx";
import { Badge, Button, ErrorBanner, Field, INPUT_CLASS, Loading } from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

/** Kinds a human types here; voice notes arrive through the voice loop (module O). */
const TYPED_KINDS = QUEUE_KINDS.filter((k) => k !== "voice_note");

function kindTone(kind: QueueItemView["kind"]) {
  switch (kind) {
    case "correction":
      return "warn" as const;
    case "task":
      return "info" as const;
    default:
      return "neutral" as const;
  }
}

/**
 * Next-session queue (spec J.2): notes, tasks, corrections and ideas with a priority and a
 * type; the agent consumes them at the start of its next session.
 */
export function QueueSection({ projectId }: { projectId: string }) {
  const client = useClient();
  const queue = useAsync(
    (signal) => client.queue(projectId, undefined, signal),
    [client, projectId],
  );
  const [kind, setKind] = useState<QueueItemView["kind"]>("note");
  const [text, setText] = useState("");
  const [priority, setPriority] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await client.enqueue(projectId, {
        kind,
        text: text.trim(),
        priority: Number(priority),
      });
      queue.setData((prev) => [created, ...(prev ?? [])]);
      setText("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await client.dismissQueueItem(id);
      queue.setData((prev) => (prev ?? []).map((q) => (q.id === id ? updated : q)));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const queued = (queue.data ?? [])
    .filter((q) => q.status === "queued")
    .sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt));
  const past = (queue.data ?? []).filter((q) => q.status !== "queued");

  return (
    <section data-testid="queue" aria-labelledby="queue-title">
      <h2 id="queue-title" className="font-semibold">
        Next session
      </h2>
      {queue.routeMissing ? (
        <RouteMissing route="queue" what="the next-session queue" />
      ) : (
        <>
          <p className="text-xs text-neutral-500">
            Notes, tasks, corrections and ideas the agent reads at the start of its next session.
          </p>
          {queue.loading && !queue.data ? <Loading what="queue" /> : null}
          {queue.error && !queue.data ? (
            <ErrorBanner message={queue.error} onRetry={queue.reload} />
          ) : null}
          {queue.data && queued.length === 0 ? (
            <p className="mt-1 text-sm text-neutral-500" data-testid="queue-empty">
              Nothing queued.
            </p>
          ) : null}
          <ul className="mt-2 space-y-1" data-testid="queue-list">
            {queued.map((q) => (
              <li
                key={q.id}
                className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 px-2 py-1 text-sm dark:border-neutral-800"
                data-testid="queue-item"
                data-kind={q.kind}
                data-queue-id={q.id}
              >
                <Badge tone={kindTone(q.kind)}>{q.kind}</Badge>
                <Badge title="Priority 1 (low) to 9 (high)">p{q.priority}</Badge>
                <span className="flex-1">{q.text}</span>
                <span className="text-xs text-neutral-500">{relativeTime(q.createdAt)}</span>
                <Button
                  variant="ghost"
                  onClick={() => void dismiss(q.id)}
                  disabled={busy}
                  data-testid="queue-dismiss"
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => void submit(e)}
            className="mt-2 grid gap-2 md:grid-cols-[auto_1fr_auto_auto]"
          >
            <Field label="Type">
              <select
                className={INPUT_CLASS}
                value={kind}
                onChange={(e) => setKind(e.target.value as QueueItemView["kind"])}
                data-testid="queue-kind"
              >
                {TYPED_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Text">
              <input
                className={INPUT_CLASS}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="What the agent should know or do next time"
                data-testid="queue-text"
              />
            </Field>
            <Field label="Priority">
              <input
                className={INPUT_CLASS}
                type="number"
                min={1}
                max={9}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                data-testid="queue-priority"
              />
            </Field>
            <div className="flex items-end">
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !text.trim()}
                data-testid="queue-add"
              >
                Queue
              </Button>
            </div>
          </form>
          {error ? <ErrorBanner message={error} /> : null}
          {past.length > 0 ? (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-neutral-500">
                {past.length} consumed or dismissed
              </summary>
              <ul className="mt-1 space-y-1">
                {past.map((q) => (
                  <li
                    key={q.id}
                    className="text-neutral-600 dark:text-neutral-400"
                    data-testid="queue-past"
                  >
                    <Badge>{q.status}</Badge> {q.text}
                    {q.consumedBySession ? ` (session ${q.consumedBySession})` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
