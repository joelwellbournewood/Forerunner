import { useState } from "react";
import { Link } from "react-router";
import { type ChangeLogView, type CommandResultJson, describeError } from "../api/client.ts";
import { CommandResult } from "../components/ChangeCardDialog.tsx";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Badge, Button, ErrorBanner, INPUT_CLASS, Loading, type Tone } from "../components/ui.tsx";
import { withoutUndoWord } from "../lib/plain-words.ts";
import { formatDateTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState } from "../store/context.tsx";

/**
 * What Undo can do for a row, from the view (later #36, U-061): "Can be undone" only when the
 * daemon says the Undo would work now (`undoable`, which already weighs the window and each
 * command's own check), "Undone", "Reverted" (a timed change that went back by itself), else
 * "Cannot be undone". Before, the badge showed the stored `undo_state`, so a row whose Undo the
 * daemon refused ("Cannot be undone now: …") still read "undoable".
 */
export function undoBadge(c: Pick<ChangeLogView, "undoable" | "undoState">): {
  label: string;
  tone: Tone;
} {
  if (c.undoable) return { label: "Can be undone", tone: "good" };
  if (c.undoState === "undone") return { label: "Undone", tone: "info" };
  if (c.undoState === "expired") return { label: "Reverted", tone: "neutral" };
  return { label: "Cannot be undone", tone: "warn" };
}

/**
 * The channels in which a person says words (design §5 rule 11): "Said:" shows what they said
 * there. A click in the app (`ui`, the palette) carries the button's words, which nobody said
 * (later #90: 'Said: "Settings: Quiet hours to from 12:00 to 18:00"').
 */
const SAID_SOURCES = new Set<ChangeLogView["source"]>(["chat", "voice", "email"]);

/** The command names of a change log row (the daemon stores `{ name, params }` objects). */
export function commandNames(commands: unknown[]): string[] {
  return commands.map((c) => {
    if (typeof c === "string") return c;
    if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") {
      return (c as { name: string }).name;
    }
    return "?";
  });
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="overflow-auto rounded bg-neutral-100 p-1 text-xs dark:bg-neutral-900">
      {JSON.stringify(value, null, 1)}
    </pre>
  );
}

/**
 * Change log (spec Q.10, Q.11): every change with who asked, the words used, the commands run,
 * before and after, and a one-click undo while it is still reversible. The same rows come
 * from the UI, chat, voice and email; only `source` and the words differ.
 */
export function ChangesPage() {
  const client = useClient();
  const { projects, me } = useUiState((s) => s);
  const [projectId, setProjectId] = useState("");
  const [onlyUndoable, setOnlyUndoable] = useState(false);
  const changes = useAsync(
    (signal) =>
      client.changes(
        { projectId: projectId || undefined, undoable: onlyUndoable, limit: 200 },
        signal,
      ),
    [client, projectId, onlyUndoable],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // An undo that raises a limit waits for its confirmation like the change itself (U-057).
  const [asking, setAsking] = useState<CommandResultJson | null>(null);
  const desktopDeviceId = useUiState((s) => s.me?.desktopDeviceId ?? null);
  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? id) : null;
  const humanName = (id: string | null) => (id && me && id === me.id ? me.name : id);

  /** What an undo or its confirmation answered, as the page says it (U-061: never "Undone" for nothing). */
  const show = (r: CommandResultJson) => {
    setAsking(r.status === "pending" ? r : null);
    if (r.status === "done" || r.status === "partial") setNote(r.sentence ?? "Undone.");
    else if (r.status === "cancelled") setNote("Undo cancelled. Nothing changed.");
    else if (r.status === "refused") setError(`Not undone: ${r.reason ?? "refused"}.`);
  };

  const undo = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    setNote(null);
    try {
      show(await client.undoChange(id));
      changes.reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  // Yes, or this PC for a high-risk undo (ADR 0030: the daemon checks the device row); No cancels.
  const answer = async (yes: boolean) => {
    if (busy || asking?.status !== "pending" || !asking.pendingId) return;
    const pendingId = asking.pendingId;
    setBusy(pendingId);
    setError(null);
    try {
      const r = await client.confirmCommand(
        pendingId,
        !yes
          ? { answer: "no" }
          : asking.decision === "needs_device"
            ? { answer: "device", ...(desktopDeviceId ? { deviceId: desktopDeviceId } : {}) }
            : { answer: "tap" },
      );
      show(r);
      changes.reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="changes-title" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 id="changes-title" className="text-xl font-semibold">
          Changes
        </h1>
        <label className="ml-auto flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={onlyUndoable}
            onChange={(e) => setOnlyUndoable(e.target.checked)}
            data-testid="changes-undoable"
          />
          Only what can be undone
        </label>
        <select
          className={`${INPUT_CLASS} w-auto`}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Project"
          data-testid="changes-project"
        >
          <option value="">all projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={changes.reload}>
          Refresh
        </Button>
      </div>
      <p className="text-xs text-neutral-500">
        Every change made here, in chat, by voice or by email: who asked, the words used, the
        commands run, before and after, and Undo while it is still reversible.
      </p>
      {changes.routeMissing ? <RouteMissing route="changes" what="the change log" /> : null}
      {changes.loading && !changes.data ? <Loading what="change log" /> : null}
      {changes.error && !changes.routeMissing && !changes.data ? (
        <ErrorBanner message={changes.error} onRetry={changes.reload} />
      ) : null}
      {error ? <ErrorBanner message={error} testId="changes-error" /> : null}
      {note ? (
        <output className="block text-sm" data-testid="changes-note">
          {note}
        </output>
      ) : null}
      {asking ? (
        <div
          className="rounded border border-amber-300 p-3 dark:border-amber-700"
          data-testid="changes-undo-pending"
        >
          <p className="mb-2 text-sm">
            Undoing this puts a value back that needs your confirmation, as setting it would.
          </p>
          <CommandResult
            result={asking}
            busy={busy !== null}
            onConfirm={(a) => void answer(a === "yes")}
            onDismiss={() => setAsking(null)}
          />
        </div>
      ) : null}
      {changes.data && changes.data.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="changes-empty">
          No changes yet.
        </p>
      ) : null}
      <ul className="space-y-2" data-testid="changes">
        {(changes.data ?? []).map((c) => (
          <li
            key={c.id}
            className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
            data-testid="change"
            data-change-id={c.id}
            data-source={c.source}
            data-undo-state={c.undoState}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info" testId="change-source">
                {c.source}
              </Badge>
              <Badge>{c.scope}</Badge>
              {c.projectId ? (
                <Link
                  to={`/projects/${encodeURIComponent(c.projectId)}`}
                  className="text-blue-700 hover:underline dark:text-blue-300"
                >
                  {projectName(c.projectId)}
                </Link>
              ) : null}
              <Badge tone={undoBadge(c).tone} testId="change-undo-state">
                {undoBadge(c).label}
              </Badge>
              <span className="ml-auto text-xs text-neutral-500">
                {humanName(c.humanId) ?? c.agentId ?? "agent"} · {formatDateTime(c.createdAt)}
              </span>
            </div>
            <p className="mt-2 font-medium" data-testid="change-sentence">
              {/* Design §5 rule 6: the Undo is the button below, never "Undo." as text. */}
              {withoutUndoWord(c.sentence).text}
            </p>
            {c.wordsUsed && SAID_SOURCES.has(c.source) ? (
              <p
                className="text-xs text-neutral-600 dark:text-neutral-400"
                data-testid="change-words"
              >
                Said: “{c.wordsUsed}”
              </p>
            ) : null}
            {c.expiresAt ? (
              <p className="text-xs text-neutral-500">Reverts at {formatDateTime(c.expiresAt)}</p>
            ) : null}
            {c.undoneAt ? (
              <p className="text-xs text-neutral-500">Undone {formatDateTime(c.undoneAt)}</p>
            ) : null}
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-neutral-500">
                {commandNames(c.commands).join(", ") || "no command"} · before / after
              </summary>
              <div className="mt-1 grid gap-2 md:grid-cols-3">
                <div>
                  <p className="text-neutral-500">Commands</p>
                  <Json value={c.commands} />
                </div>
                <div>
                  <p className="text-neutral-500">Before</p>
                  <Json value={c.before} />
                </div>
                <div>
                  <p className="text-neutral-500">After</p>
                  <Json value={c.after} />
                </div>
              </div>
            </details>
            {c.undoable ? (
              <div className="mt-2">
                <Button
                  onClick={() => void undo(c.id)}
                  disabled={busy !== null}
                  data-testid="change-undo"
                >
                  Undo
                </Button>
              </div>
            ) : c.undoBlockedReason ? (
              <p
                className="mt-2 text-xs text-neutral-600 dark:text-neutral-400"
                data-testid="change-undo-blocked"
              >
                Cannot be undone now: {c.undoBlockedReason}.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
