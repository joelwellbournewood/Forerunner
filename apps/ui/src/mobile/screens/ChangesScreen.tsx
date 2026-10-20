import { useMemo, useState } from "react";
import { describeStateError } from "../../api/state-client.ts";
import { Badge, Button, EmptyState, ErrorBanner, statusTone } from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import type { ChangeEntry } from "../change-log.ts";
import { useMobileController, useMobileState } from "../store.tsx";

/** The change log (spec Q.11): who asked, the words, the commands, before and after, Undo. */
export function ChangesScreen() {
  const controller = useMobileController();
  const version = useMobileState((s) => s.changeLogVersion);
  const humanName = useMobileState((s) => s.session?.humanName ?? "you");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the version is the cache key
  const entries = useMemo(() => controller.changeLog.all(), [controller, version]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const undo = async (entry: ChangeEntry) => {
    setBusy(entry.id);
    setError(null);
    try {
      await controller.undo(entry.id);
    } catch (e) {
      setError(describeStateError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="m-changes-title" className="space-y-3">
      <h1 id="m-changes-title" className="text-xl font-semibold">
        Change log
      </h1>
      {entries.length === 0 ? (
        <EmptyState testId="m-no-changes">No changes from this phone yet.</EmptyState>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
      <ol className="space-y-2" data-testid="m-change-list">
        {entries.map((e) => (
          <li
            key={e.id}
            className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
            data-testid="m-change-entry"
            data-status={e.status}
            data-entry-id={e.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                tone={statusTone(e.status === "sent" ? "pending" : e.status)}
                testId="m-change-status"
              >
                {e.status}
              </Badge>
              <Badge>{e.source}</Badge>
              {e.undoOf ? <Badge tone="info">undo</Badge> : null}
              <span className="text-xs text-neutral-500">{relativeTime(e.at)}</span>
              {controller.changeLog.canUndo(e) ? (
                <Button
                  variant="secondary"
                  className="ml-auto"
                  onClick={() => void undo(e)}
                  disabled={busy !== null}
                  data-testid="m-change-undo"
                >
                  Undo
                </Button>
              ) : null}
            </div>
            <p className="mt-2 font-medium">{e.card.sentence}</p>
            <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
              {humanName} said: “{e.wordsUsed}”
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Commands: {e.plan.map((c) => c.name).join(", ")} · {e.card.oldValue} →{" "}
              {e.card.newValue}
            </p>
            {e.remoteCommandId ? (
              <p className="text-xs text-neutral-500">Remote command {e.remoteCommandId}</p>
            ) : (
              <p className="text-xs text-neutral-500">Queued offline</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
