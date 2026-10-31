import { PRIORITY_LABELS } from "@forerunner/runtime/priority";
import { type FormEvent, useMemo, useState } from "react";
import { Link } from "react-router";
import { describeError, type RunView, type TaskView } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
  Money,
  statusTone,
} from "../../components/ui.tsx";
import type { MoneyLike } from "../../lib/money.ts";
import { reviewLevel, verdictLabel } from "../../lib/plain-words.ts";
import {
  defaultTransitionReason,
  humanTransitions,
  TASK_STATUSES,
  transitionLabel,
} from "../../lib/task-transitions.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";
import { DependencyPicker, describeDependencies, hasStuckDependency } from "./DependencyPicker.tsx";
import { NewTaskDialog } from "./NewTaskDialog.tsx";

/** The reason sent when the dependencies dialog's reason is left empty (spec B.5, U-010). */
export const DEFAULT_DEPENDENCIES_REASON = "Dependencies changed in the app";

/** Statuses whose dependencies no longer matter: the task will not run again. */
const FINISHED: readonly string[] = ["done", "cancelled"];

/** Latest run per task, for the verdict, review and PR columns. */
export function latestRunByTask(runs: RunView[]): Map<string, RunView> {
  const map = new Map<string, RunView>();
  for (const r of runs) {
    if (!r.taskId) continue;
    const prev = map.get(r.taskId);
    if (!prev || r.createdAt > prev.createdAt) map.set(r.taskId, r);
  }
  return map;
}

export interface TaskFilter {
  status: string;
  specialist: string;
  text: string;
}

/**
 * What a run of the task stops at (U-042), under its cost: the task's budget when it has one
 * (the spend of all its runs together stops there), else the specialist's limit per run. The
 * estimate is the plan's forecast and never stops a run, so it is not shown as a limit.
 */
function TaskCap({ task, specialist }: { task: TaskView; specialist: string | null }) {
  if (task.capSource === "task_budget")
    return (
      <div
        className="text-xs text-neutral-500"
        data-testid="task-cap"
        title="Runs of this task stop when its spend reaches this budget"
      >
        of <Money value={task.budget} /> budget
      </div>
    );
  if (task.capSource === "specialist_limit")
    return (
      <div
        className="text-xs text-neutral-500"
        data-testid="task-cap"
        title="The task has no budget: each run stops at its specialist's limit. Set a budget to change it."
      >
        no budget; each run stops at <Money value={task.cap} /> ({specialist ?? "coder"} limit)
      </div>
    );
  return (
    <div className="text-xs text-neutral-500" data-testid="task-cap">
      no budget
    </div>
  );
}

export function filterTasks(tasks: TaskView[], filter: TaskFilter): TaskView[] {
  const text = filter.text.trim().toLowerCase();
  return tasks.filter((t) => {
    if (filter.status && t.status !== filter.status) return false;
    if (filter.specialist && (t.specialist ?? "") !== filter.specialist) return false;
    if (text && !`${t.title} ${t.outcome} ${t.id}`.toLowerCase().includes(text)) return false;
    return true;
  });
}

export function TasksTab({
  projectId,
  reference,
  defaultRiskTier,
}: {
  projectId: string;
  /** Money pair carrying the day's rate for the CHF budget field of the New task dialog. */
  reference?: MoneyLike;
  /** The project card's default tier for a new task, named on the dialog's default option. */
  defaultRiskTier?: number;
}) {
  const client = useClient();
  const tasks = useAsync(
    (signal) => client.tasks(projectId, { limit: 500 }, signal),
    [client, projectId],
  );
  const runs = useAsync(
    (signal) => client.runs(projectId, { limit: 500 }, signal),
    [client, projectId],
  );
  const [filter, setFilter] = useState<TaskFilter>({ status: "", specialist: "", text: "" });
  const [newOpen, setNewOpen] = useState(false);
  const [transition, setTransition] = useState<{ task: TaskView; to: string } | null>(null);
  const [editing, setEditing] = useState<TaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data]);
  // The last move, as the change log has it (U-061): its sentence and, while it can be undone,
  // the change log id its Undo sends.
  const [moved, setMoved] = useState<{ sentence: string; undoToken: string | null } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);

  const byTask = useMemo(() => latestRunByTask(runs.data ?? []), [runs.data]);
  const specialists = useMemo(
    () =>
      [
        ...new Set((tasks.data ?? []).map((t) => t.specialist).filter((s): s is string => !!s)),
      ].sort(),
    [tasks.data],
  );
  const visible = useMemo(() => filterTasks(tasks.data ?? [], filter), [tasks.data, filter]);

  const doTransition = async (task: TaskView, to: string, reason: string) => {
    try {
      const { change, ...updated } = await client.transitionTask(task.id, {
        version: task.version,
        to,
        reason,
      });
      tasks.setData((prev) => (prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev));
      setMoved(change ? { sentence: change.sentence, undoToken: change.undoToken } : null);
      setError(null);
    } catch (err) {
      setError(describeError(err));
      throw err;
    }
  };

  return (
    <div className="space-y-3" data-testid="tasks">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Status</span>
          <select
            className={INPUT_CLASS}
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value })}
            data-testid="filter-status"
          >
            <option value="">all</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Specialist</span>
          <select
            className={INPUT_CLASS}
            value={filter.specialist}
            onChange={(e) => setFilter({ ...filter, specialist: e.target.value })}
            data-testid="filter-specialist"
          >
            <option value="">all</option>
            {specialists.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1 text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Search</span>
          <input
            className={INPUT_CLASS}
            value={filter.text}
            onChange={(e) => setFilter({ ...filter, text: e.target.value })}
            placeholder="title, outcome or id"
            data-testid="filter-text"
          />
        </label>
        <Button
          variant="ghost"
          onClick={() => {
            tasks.reload();
            runs.reload();
          }}
        >
          Refresh
        </Button>
        <Button variant="primary" onClick={() => setNewOpen(true)} data-testid="new-task">
          New task
        </Button>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      {moved ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="task-moved">
          <output data-testid="task-moved-sentence">{moved.sentence}</output>
          {moved.undoToken ? (
            <Button
              variant="ghost"
              disabled={undoBusy}
              onClick={() => {
                const id = moved.undoToken;
                if (!id) return;
                setUndoBusy(true);
                void client
                  .undoChange(id)
                  .then((r) => {
                    if (r.status === "done" || r.status === "partial") {
                      setMoved({ sentence: r.sentence ?? "Undone.", undoToken: null });
                      setError(null);
                      tasks.reload();
                    } else {
                      setError(`Not undone: ${r.reason ?? r.status}.`);
                    }
                  })
                  .catch((err: unknown) => setError(describeError(err)))
                  .finally(() => setUndoBusy(false));
              }}
              data-testid="task-moved-undo"
            >
              Undo
            </Button>
          ) : null}
          <Link to="/changes" className="text-xs text-blue-700 hover:underline dark:text-blue-300">
            In Changes
          </Link>
        </div>
      ) : null}
      {tasks.loading && !tasks.data ? <Loading what="tasks" /> : null}
      {tasks.error && !tasks.data ? (
        <ErrorBanner message={tasks.error} onRetry={tasks.reload} />
      ) : null}
      {tasks.data && tasks.data.length === 0 ? (
        <EmptyState testId="no-tasks">
          No tasks yet. Add one, or let the agent plan from the brief.
        </EmptyState>
      ) : null}
      {tasks.data && tasks.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="task-table">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th className="py-1 pr-2">Task</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2">Specialist</th>
                <th className="py-1 pr-2">Cost</th>
                <th className="py-1 pr-2" title="The critic's last review of the task">
                  Critic
                </th>
                <th className="py-1 pr-2">Links</th>
                <th className="py-1">Move to</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const run = byTask.get(t.id);
                const prUrl = t.prUrl ?? run?.prUrl ?? null;
                return (
                  <tr
                    key={t.id}
                    className="border-t border-neutral-100 align-top dark:border-neutral-800"
                    data-testid="task-row"
                    data-task-id={t.id}
                    data-status={t.status}
                  >
                    <td className="py-1.5 pr-2">
                      <div className="font-medium">{t.title}</div>
                      <div className="text-xs text-neutral-500">
                        {reviewLevel(t.riskTier)} · {PRIORITY_LABELS[t.priority]} priority
                        {t.attempt > 1 ? ` · attempt ${t.attempt}` : ""}
                        {t.dependsOn.length > 0 ? ` · after ${describeDependencies(t, byId)}` : ""}
                      </div>
                      {t.status === "ready" && hasStuckDependency(t, byId) ? (
                        <div
                          className="text-xs text-amber-800 dark:text-amber-200"
                          data-testid="stuck-dependency"
                        >
                          Waits on a task that will not be done by itself: no session runs this one
                          until you change what it depends on.
                        </div>
                      ) : null}
                      {t.reason ? (
                        <div className="text-xs text-neutral-600 dark:text-neutral-400">
                          {t.reason}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-2">
                      <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                      {t.claimedBy ? (
                        <div className="text-xs text-neutral-500">claimed by {t.claimedBy}</div>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-2">{t.specialist ?? run?.specialist ?? "—"}</td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <Money value={t.actual} />
                      <TaskCap task={t} specialist={t.specialist ?? run?.specialist ?? null} />
                    </td>
                    <td className="py-1.5 pr-2">
                      {run?.verdict ? (
                        <Badge
                          tone={
                            run.verdict === "accept" || run.verdict === "pass" ? "good" : "warn"
                          }
                        >
                          {verdictLabel(run.verdict)}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      {prUrl ? (
                        <a
                          href={prUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-700 hover:underline dark:text-blue-300"
                          data-testid="pr-link"
                        >
                          PR
                        </a>
                      ) : null}
                      {run?.reviewId ? (
                        <>
                          {prUrl ? " · " : ""}
                          <Link
                            to={`/projects/${encodeURIComponent(projectId)}/reviews?review=${encodeURIComponent(run.reviewId)}`}
                            className="text-blue-700 hover:underline dark:text-blue-300"
                            data-testid="review-link"
                          >
                            review
                          </Link>
                        </>
                      ) : null}
                      {!prUrl && !run?.reviewId ? "—" : null}
                    </td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {humanTransitions(t.status).map((to) => (
                          <Button
                            key={to}
                            variant={to === "cancelled" || to === "failed" ? "ghost" : "secondary"}
                            className="px-2 py-0.5 text-xs"
                            onClick={() => setTransition({ task: t, to })}
                            data-testid={`transition-${to}`}
                          >
                            {transitionLabel(to)}
                          </Button>
                        ))}
                        {FINISHED.includes(t.status) ? null : (
                          <Button
                            variant="ghost"
                            className="px-2 py-0.5 text-xs"
                            onClick={() => setEditing(t)}
                            data-testid="edit-dependencies"
                          >
                            Depends on…
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 ? <EmptyState>No task matches the filters.</EmptyState> : null}
        </div>
      ) : null}
      <NewTaskDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        projectId={projectId}
        reference={reference}
        defaultRiskTier={defaultRiskTier}
        onCreated={(task) => tasks.setData((prev) => (prev ? [task, ...prev] : [task]))}
      />
      <DependenciesDialog
        task={editing}
        tasks={tasks.data}
        onClose={() => setEditing(null)}
        onSave={async (task, dependsOn, reason) => {
          const updated = await client.setTaskDependencies(task.id, {
            version: task.version,
            dependsOn,
            reason,
          });
          tasks.setData((prev) =>
            prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev,
          );
          setEditing(null);
        }}
      />
      <TransitionDialog
        pending={transition}
        onClose={() => setTransition(null)}
        onConfirm={async (reason) => {
          if (!transition) return;
          await doTransition(transition.task, transition.to, reason);
          setTransition(null);
        }}
      />
    </div>
  );
}

/**
 * Change the tasks a task waits on (U-040): the project's tasks by title, with the version the
 * row shows and an optional reason; the daemon refuses a cancelled task, the task itself and a
 * cycle with a message naming them, shown here.
 */
function DependenciesDialog({
  task,
  tasks,
  onClose,
  onSave,
}: {
  task: TaskView | null;
  tasks: readonly TaskView[] | null;
  onClose: () => void;
  onSave: (task: TaskView, dependsOn: string[], reason: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  // A new task to edit resets the form to what that task waits on now.
  if (task && shown !== task.id) {
    setShown(task.id);
    setSelected([...task.dependsOn]);
    setReason("");
    setError(null);
  }
  if (!task && shown !== null) setShown(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !task) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(task, selected, reason.trim() || DEFAULT_DEPENDENCIES_REASON);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={task !== null}
      onClose={onClose}
      title={task ? `Depends on: ${task.title}` : ""}
      testId="dependencies-dialog"
    >
      <form onSubmit={submit} className="space-y-3">
        <fieldset className="text-sm">
          <legend className="mb-1 block font-medium">This task runs after</legend>
          <DependencyPicker
            tasks={tasks}
            selected={selected}
            onChange={setSelected}
            excludeId={task?.id}
          />
          <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
            A session plans this task only once every task ticked here is done. Untick all to let it
            run on its own.
          </span>
        </fieldset>
        <Field
          label="Reason (optional)"
          hint={`Recorded on the task; your agent reads it. Left empty: "${DEFAULT_DEPENDENCIES_REASON}".`}
        >
          <input
            className={INPUT_CLASS}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="dependencies-reason"
          />
        </Field>
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy} data-testid="save-dependencies">
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** States in which a session's run may be working on the task (U-039). */
const RUNNING_STATUSES: readonly string[] = ["claimed", "in_progress"];

/** How the note names the state a move leaves a running task in. */
function movedLabel(to: string): string {
  switch (to) {
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "needs_human":
      return "waiting for you";
    case "in_review":
      return "in review";
    default:
      return to;
  }
}

function TransitionDialog({
  pending,
  onClose,
  onConfirm,
}: {
  pending: { task: TaskView; to: string } | null;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !pending) return;
    setBusy(true);
    setError(null);
    try {
      // Optional (U-010): an empty reason is recorded as what changed.
      await onConfirm(reason.trim() || defaultTransitionReason(pending.to));
      setReason("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={pending !== null}
      onClose={onClose}
      title={pending ? `${transitionLabel(pending.to)}: ${pending.task.title}` : ""}
      testId="transition-dialog"
    >
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {pending ? `${pending.task.status} → ${pending.to}` : ""}
        </p>
        {pending && RUNNING_STATUSES.includes(pending.task.status) ? (
          <p
            role="note"
            className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
            data-testid="transition-stops-run"
          >
            A session is working on this task. Its run stops now; the session goes on with its other
            tasks and leaves this one {movedLabel(pending.to)}.
          </p>
        ) : null}
        <Field
          label="Reason (optional)"
          hint={`Recorded on the task and in the change log; your agent reads it.${
            pending ? ` Left empty: "${defaultTransitionReason(pending.to)}".` : ""
          }`}
        >
          <input
            className={INPUT_CLASS}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
            data-testid="transition-reason"
          />
        </Field>
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} data-testid="dismiss-transition">
            {pending?.to === "cancelled" ? "Keep task" : "Close"}
          </Button>
          <Button variant="primary" type="submit" disabled={busy} data-testid="confirm-transition">
            {busy ? "Saving…" : pending?.to === "cancelled" ? "Cancel task" : "Confirm"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
