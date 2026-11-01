import { type FormEvent, useState } from "react";
import { describeError } from "../../api/client.ts";
import type { QueueItemView } from "../../api/contracts.ts";
import { RouteMissing } from "../../components/RouteMissing.tsx";
import { Button, ErrorBanner, INPUT_CLASS } from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

/** What a note does, said with the box (design §3.4; `session/next-session.ts`). */
export const NOTE_EXPLAIN =
  "Goes into the brief of every task the next session runs, or of the task it names.";

/** The priority a note is queued at: the middle of the queue's 1 to 9. */
const NOTE_PRIORITY = 5;

/**
 * Items the person did not write and cannot act on: the first-session plan an approved brief
 * queues (`session/first-session.ts`), which only says which tasks the first session runs.
 */
function isOwnNote(q: QueueItemView): boolean {
  return !/^First-session plan\b/.test(q.text);
}

/**
 * Note for the next session (design §3.4): one text box. It replaces the next-session queue
 * form with its types and priorities, which the walks found to be internals ("task p9
 * First-session plan (approved intake 01a1992e-…)"). A note is a queue item of kind `note`; the
 * next session takes it in as before: it reaches the brief of the task it names, or every
 * task's brief when it names none (U-038). Items already queued (of any kind) keep what they
 * mean and can be dismissed.
 */
export function QueueSection({ projectId }: { projectId: string }) {
  const client = useClient();
  const queue = useAsync(
    (signal) => client.queue(projectId, undefined, signal),
    [client, projectId],
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const created = await client.enqueue(projectId, {
        kind: "note",
        text: text.trim(),
        priority: NOTE_PRIORITY,
      });
      queue.setData((prev) => [created, ...(prev ?? [])]);
      setText("");
      setSaved(true);
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
    .filter((q) => q.status === "queued" && isOwnNote(q))
    .sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt));

  return (
    <section data-testid="queue" aria-labelledby="queue-title">
      <h2 id="queue-title" className="font-semibold">
        Note for the next session
      </h2>
      {queue.routeMissing ? (
        <RouteMissing route="queue" what="the note for the next session" />
      ) : (
        <>
          <form onSubmit={(e) => void submit(e)} className="mt-1 flex flex-wrap gap-2">
            <input
              className={`${INPUT_CLASS} min-w-64 flex-1`}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setSaved(false);
              }}
              placeholder="What the agent should know next time"
              aria-label="Note for the next session"
              aria-describedby="queue-explainer"
              data-testid="queue-text"
            />
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !text.trim()}
              data-testid="queue-add"
            >
              Save note
            </Button>
          </form>
          <p
            id="queue-explainer"
            className="mt-1 text-xs text-neutral-500"
            data-testid="queue-explainer"
          >
            {NOTE_EXPLAIN}
          </p>
          {saved ? (
            <output
              className="block text-xs text-green-800 dark:text-green-300"
              data-testid="queue-saved"
            >
              Saved. The next session reads it.
            </output>
          ) : null}
          {queue.error && !queue.data ? (
            <ErrorBanner message={queue.error} onRetry={queue.reload} />
          ) : null}
          {queued.length > 0 ? (
            <ul className="mt-2 space-y-1" data-testid="queue-list">
              {queued.map((q) => (
                <li
                  key={q.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 px-2 py-1 text-sm dark:border-neutral-800"
                  data-testid="queue-item"
                  data-kind={q.kind}
                  data-queue-id={q.id}
                >
                  <span className="flex-1">{q.text}</span>
                  <span className="text-xs text-neutral-500">{relativeTime(q.createdAt)}</span>
                  <Button
                    variant="ghost"
                    onClick={() => void dismiss(q.id)}
                    disabled={busy}
                    data-testid="queue-dismiss"
                    title="The next session will not read it."
                  >
                    Dismiss
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <ErrorBanner message={error} /> : null}
        </>
      )}
    </section>
  );
}
