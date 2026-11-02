import { PRIORITY_LABELS } from "@forerunner/runtime/priority";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  ApiError,
  describeError,
  type RunView,
  type TaskAction,
  type TaskTransitionView,
  type TaskView,
} from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { ExternalLink } from "../../components/ExternalLink.tsx";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
  Money,
} from "../../components/ui.tsx";
import type { MoneyLike } from "../../lib/money.ts";
import { verdictLabel } from "../../lib/plain-words.ts";
import {
  ACTIONS,
  actionsFor,
  cancelWorkLine,
  displayOf,
  elapsed,
  isFinished,
  reviewLevelName,
  STATUS_FILTERS,
  stuckLine,
  type TaskActionKey,
  WHO_PERSON,
  whoName,
} from "../../lib/task-actions.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient, useIdentity, useUiState, useUiStore } from "../../store/context.tsx";
import { DependencyPicker } from "./DependencyPicker.tsx";
import { NewTaskDialog } from "./NewTaskDialog.tsx";
import { TaskDrawer } from "./TaskDrawer.tsx";

/** Latest run per task, for the verdict and specialist columns. */
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
  /** A status in words (`TaskDisplay.key`), "" for all. */
  status: string;
  specialist: string;
  text: string;
}

/**
 * What a run of the task stops at (U-042), under its cost, for a task not done or cancelled:
 * the task's budget when it has one (the spend of all its runs together stops there), else the
 * specialist's limit per run. The estimate is the plan's forecast and never stops a run.
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
        each run stops at <Money value={task.cap} /> ({specialist ?? "coder"} limit)
      </div>
    );
  return null;
}

/** The filters over what the rows show: the status in words, who does it, the title or outcome. */
export function filterTasks(tasks: TaskView[], filter: TaskFilter): TaskView[] {
  const text = filter.text.trim().toLowerCase();
  return tasks.filter((t) => {
    if (filter.status && displayOf(t).key !== filter.status) return false;
    if (filter.specialist && (t.specialist ?? "") !== filter.specialist) return false;
    if (text && !`${t.title} ${t.outcome}`.toLowerCase().includes(text)) return false;
    return true;
  });
}

/** The open tasks that wait on a task: Cancel names them (design §3.5). */
export function waitingOn(task: Pick<TaskView, "id">, tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((t) => t.dependsOn.includes(task.id) && !isFinished(t));
}

/** The filters' names in the address (`?status=&who=&q=`). */
const FILTER_KEYS = ["status", "who", "q"] as const;
type KeptFilters = Record<(typeof FILTER_KEYS)[number], string>;
/** Each window's (store's) last Tasks filters per project, for a return to the tab. */
const keptFilters = new WeakMap<object, Map<string, KeptFilters>>();
function rememberedFilters(store: object): Map<string, KeptFilters> {
  let kept = keptFilters.get(store);
  if (!kept) {
    kept = new Map();
    keptFilters.set(store, kept);
  }
  return kept;
}

/** A change the person just made, with its one Undo (design §3.5). */
interface Moved {
  sentence: string;
  undoToken: string | null;
}

/**
 * The Tasks tab (design §3.5): one row per task in run order, its status in words, who does
 * it, cost and critic result; per-status actions with a one-line explanation, a note for the
 * agent and one Undo after each; the task drawer on a click of the title. Rows follow the work
 * live: the project's `project.changed` (a session began, finished or moved a task) reloads
 * them, and while a task runs they are read again every few seconds.
 */
export function TasksTab({
  projectId,
  reference,
  defaultRiskTier,
}: {
  projectId: string;
  /** Money pair carrying the day's rate for the CHF budget fields. */
  reference?: MoneyLike;
  /** The project card's default tier for a new task, named on the dialog's default option. */
  defaultRiskTier?: number;
}) {
  const client = useClient();
  const navigate = useNavigate();
  const tasks = useAsync(
    (signal) => client.tasks(projectId, { limit: 500 }, signal),
    [client, projectId],
  );
  const runs = useAsync(
    (signal) => client.runs(projectId, { limit: 500 }, signal),
    [client, projectId],
  );
  // The filters live in the address, so a reload and Back keep them; the project's tab links
  // carry no query, so this window also remembers them per project and puts them back when the
  // person returns to the tab (design §3.5: leave the tab and come back, they are still set).
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const who = params.get("who") ?? "";
  const q = params.get("q") ?? "";
  const filter: TaskFilter = useMemo(
    () => ({ status, specialist: who, text: q }),
    [status, who, q],
  );
  const uiStore = useUiStore();
  const remembered = rememberedFilters(uiStore);
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    const kept = remembered.get(projectId);
    if (!kept || FILTER_KEYS.some((k) => params.has(k))) return;
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        for (const k of FILTER_KEYS) if (kept[k]) p.set(k, kept[k]);
        return p;
      },
      { replace: true },
    );
  }, [remembered, projectId, params, setParams]);
  // Whatever set them (these fields, a link with a filter), they are kept for the next visit.
  useEffect(() => {
    if (arrived.current) remembered.set(projectId, { status, who, q });
  }, [remembered, projectId, status, who, q]);
  const setFilter = (patch: Partial<TaskFilter>) => {
    const next = { ...filter, ...patch };
    const values = { status: next.status, who: next.specialist, q: next.text };
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        for (const k of FILTER_KEYS) {
          if (values[k]) p.set(k, values[k]);
          else p.delete(k);
        }
        return p;
      },
      { replace: true },
    );
  };
  const openId = params.get("task");
  const setOpen = (id: string | null) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (id) p.set("task", id);
        else p.delete("task");
        return p;
      },
      { replace: true },
    );

  const [newOpen, setNewOpen] = useState(false);
  const [pending, setPending] = useState<{ task: TaskView; action: TaskAction } | null>(null);
  const [editingDeps, setEditingDeps] = useState<TaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<Moved | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const reloadAll = useCallback(() => {
    tasks.reload();
    runs.reload();
  }, [tasks.reload, runs.reload]);
  const identity = useIdentity();
  const refreshInboxCount = () => {
    if (!identity) return;
    void client
      .inbox(identity.humanId)
      .then((inbox) =>
        uiStore.dispatch({
          type: "blockingCount",
          count: inbox.needsYouCount ?? inbox.blockingCount,
        }),
      )
      .catch(() => {
        // the /events stream or the next poll brings the count
      });
  };

  // Live (design §3.5): the store re-reads the project card on every `project.changed`, which
  // the daemon sends when a session moves a task; the rows follow it, once per burst.
  const card = useUiState((s) => s.projects.find((p) => p.id === projectId));
  const seenCard = useRef(card);
  useEffect(() => {
    if (seenCard.current === card) return;
    seenCard.current = card;
    const handle = setTimeout(reloadAll, 200);
    return () => clearTimeout(handle);
  }, [card, reloadAll]);
  // While a task runs (or the critic reviews it) the rows are read again every few seconds
  // too, in case the event stream is down, and "Running (2 min)" counts on.
  const active = (tasks.data ?? []).some((t) =>
    ["claimed", "in_progress", "in_review"].includes(t.status),
  );
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => {
      setNow(Date.now());
      reloadAll();
    }, 5000);
    return () => clearInterval(handle);
  }, [active, reloadAll]);

  const all = useMemo(() => tasks.data ?? [], [tasks.data]);
  const byTask = useMemo(() => latestRunByTask(runs.data ?? []), [runs.data]);
  const specialists = useMemo(
    () => [...new Set(all.map((t) => t.specialist).filter((s): s is string => !!s))].sort(),
    [all],
  );
  const visible = useMemo(() => filterTasks(all, filter), [all, filter]);

  /** Put the task the daemon answered into its row. */
  const replaceRow = (updated: TaskView) =>
    tasks.setData((prev) => (prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev));
  const changed = (r: TaskTransitionView) => {
    const { change, ...updated } = r;
    replaceRow(updated);
    setMoved(change ? { sentence: change.sentence, undoToken: change.undoToken } : null);
    setError(null);
    // Others may change with it (what waits on a cancelled task is stuck now).
    tasks.reload();
  };

  const start = (task: TaskView, key: TaskActionKey) => {
    if (key === "edit") return setOpen(task.id);
    if (key === "dependencies") return setEditingDeps(task);
    if (key === "answer") return navigate("/inbox");
    setPending({ task, action: key });
  };

  return (
    <div className="space-y-3" data-testid="tasks">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Status</span>
          <select
            className={INPUT_CLASS}
            value={filter.status}
            onChange={(e) => setFilter({ status: e.target.value })}
            data-testid="filter-status"
          >
            <option value="">All</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Who does it</span>
          <select
            className={INPUT_CLASS}
            value={filter.specialist}
            onChange={(e) => setFilter({ specialist: e.target.value })}
            data-testid="filter-specialist"
          >
            <option value="">Anyone</option>
            {specialists.map((s) => (
              <option key={s} value={s}>
                {whoName(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1 text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Search</span>
          <input
            className={INPUT_CLASS}
            value={filter.text}
            onChange={(e) => setFilter({ text: e.target.value })}
            placeholder="title or what done looks like"
            data-testid="filter-text"
          />
        </label>
        <Button variant="ghost" onClick={reloadAll}>
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
                      // An undo can put a withdrawn card back: the header's count follows.
                      refreshInboxCount();
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
          No tasks yet. Press New task, or describe them in Chat.
        </EmptyState>
      ) : null}
      {tasks.data && tasks.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="task-table">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th className="py-1 pr-2">Task</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2">Who does it</th>
                <th className="py-1 pr-2">Cost</th>
                <th className="py-1 pr-2" title="The critic's last review of the task">
                  Critic
                </th>
                <th className="py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const run = byTask.get(t.id);
                const prUrl = t.prUrl ?? run?.prUrl ?? null;
                const d = displayOf(t);
                const since = d.key === "running" ? elapsed(d.since, now) : null;
                const who = t.specialist ?? run?.specialist ?? null;
                return (
                  <tr
                    key={t.id}
                    className="border-t border-neutral-100 align-top dark:border-neutral-800"
                    data-testid="task-row"
                    data-task-id={t.id}
                    data-status={d.key}
                  >
                    <td className="py-1.5 pr-2">
                      <button
                        type="button"
                        className="text-left font-medium hover:underline"
                        onClick={() => setOpen(t.id)}
                        data-testid="task-title"
                      >
                        {t.title}
                      </button>
                      <div className="text-xs text-neutral-500">
                        {reviewLevelName(t.riskTier)} · {PRIORITY_LABELS[t.priority]} priority
                        {t.attempt > 1 ? ` · attempt ${t.attempt}` : ""}
                        {prUrl ? (
                          <>
                            {" · "}
                            <ExternalLink href={prUrl} variant="inline" testId="pr-link">
                              PR
                            </ExternalLink>
                          </>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-1.5 pr-2">
                      <Badge tone={d.tone} testId="task-status">
                        {d.label}
                      </Badge>
                      {d.key === "running" && (d.agentName || since) ? (
                        <div className="text-xs text-neutral-500" data-testid="task-running">
                          {[d.agentName, since].filter(Boolean).join(", ")}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-2">{whoName(who)}</td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <Money value={t.actual} />
                      {isFinished(t) || who === WHO_PERSON ? null : (
                        <TaskCap task={t} specialist={who} />
                      )}
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
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {actionsFor(d.key, t)
                          .filter((a) => a !== "edit" && a !== "dependencies")
                          .map((a, i) => (
                            <Button
                              key={a}
                              variant={i === 0 && a !== "cancel" ? "secondary" : "ghost"}
                              className="px-2 py-0.5 text-xs"
                              title={ACTIONS[a].explain}
                              onClick={() => start(t, a)}
                              data-testid={`action-${a}`}
                            >
                              {ACTIONS[a].label}
                            </Button>
                          ))}
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
        onCreated={(r) => changed(r)}
      />
      <TaskDrawer
        taskId={openId}
        tasks={all}
        reference={reference}
        onClose={() => setOpen(null)}
        onAction={(task, key) => start(task, key)}
        onChanged={changed}
      />
      <DependenciesDialog
        task={editingDeps}
        tasks={tasks.data}
        onClose={() => setEditingDeps(null)}
        onSave={async (task, dependsOn, note) => {
          changed(
            await client.setTaskDependencies(task.id, {
              version: task.version,
              dependsOn,
              ...(note ? { note } : {}),
            }),
          );
          setEditingDeps(null);
        }}
      />
      <ActionDialog
        pending={pending}
        tasks={all}
        onClose={() => setPending(null)}
        onConfirm={async (note) => {
          if (!pending) return;
          try {
            changed(
              await client.taskAction(pending.task.id, {
                version: pending.task.version,
                action: pending.action,
                ...(note ? { note } : {}),
              }),
            );
            setPending(null);
          } catch (err) {
            // The task changed meanwhile: the row and the dialog show what it is now.
            const now = changedMeanwhile(err);
            if (now) {
              replaceRow(now);
              setPending({ task: now, action: pending.action });
            }
            throw err;
          }
        }}
      />
    </div>
  );
}

/** The task as it is now, from a 409 that says the row was out of date. */
export function changedMeanwhile(err: unknown): TaskView | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const task = err.details?.task as TaskView | undefined;
  return task && typeof task.id === "string" && typeof task.version === "number" ? task : null;
}

/**
 * One action's dialog (design §3.5): "Pause "X"?", the action's one-line consequence (Cancel
 * names the tasks that wait on it), and "Note for the agent (optional)", which goes into the
 * task's next brief. A task that changed meanwhile is shown as it is now, once.
 */
export function ActionDialog({
  pending,
  tasks,
  onClose,
  onConfirm,
}: {
  pending: { task: TaskView; action: TaskAction } | null;
  tasks: readonly TaskView[];
  onClose: () => void;
  onConfirm: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const key = pending ? `${pending.task.id}:${pending.action}` : null;
  if (key !== shown) {
    setShown(key);
    if (!pending || !shown?.startsWith(`${pending.task.id}:`)) {
      setNote("");
      setError(null);
    }
  }
  if (!pending) return null;
  const { task, action } = pending;
  const def = ACTIONS[action];
  const offered = actionsFor(displayOf(task).key, task).includes(action);
  const stuck = action === "cancel" ? stuckLine(waitingOn(task, tasks).map((t) => t.title)) : null;
  const work = action === "cancel" ? cancelWorkLine(task) : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(note.trim());
      setNote("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`${def.label} "${task.title}"?`} testId="action-dialog">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm" data-testid="action-explain">
          {def.explain}
          {work ? ` ${work}` : ""}
          {stuck ? ` ${stuck}` : ""}
        </p>
        {offered ? (
          <Field label="Note for the agent (optional)" hint="Goes into the task's next brief.">
            <textarea
              className={`${INPUT_CLASS} min-h-16`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="action-note"
            />
          </Field>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} data-testid="dismiss-action">
            {action === "cancel" ? "Keep task" : "Not now"}
          </Button>
          {offered ? (
            <Button
              variant={action === "cancel" ? "danger" : "primary"}
              type="submit"
              disabled={busy}
              data-testid="confirm-action"
            >
              {busy ? "Saving…" : action === "cancel" ? "Cancel task" : def.label}
            </Button>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Change what a task waits for (U-040, design §3.5): the project's tasks by title, a note for
 * the agent; the daemon refuses a cancelled task, the task itself and a cycle with a message
 * naming them, shown here. Logged with its Undo.
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
  onSave: (task: TaskView, dependsOn: string[], note: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  // A new task to edit resets the form to what that task waits on now.
  if (task && shown !== task.id) {
    setShown(task.id);
    setSelected([...task.dependsOn]);
    setNote("");
    setError(null);
  }
  if (!task && shown !== null) setShown(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !task) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(task, selected, note.trim());
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
      title={task ? `What "${task.title}" waits for` : ""}
      testId="dependencies-dialog"
    >
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm">{ACTIONS.dependencies.explain}</p>
        <fieldset className="text-sm">
          <legend className="mb-1 block font-medium">It runs after</legend>
          <DependencyPicker
            tasks={tasks}
            selected={selected}
            onChange={setSelected}
            excludeId={task?.id}
          />
          <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
            A session runs this task only once every task ticked here is done. Untick all to let it
            run on its own.
          </span>
        </fieldset>
        <Field label="Note for the agent (optional)" hint="Goes into the task's next brief.">
          <input
            className={INPUT_CLASS}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="dependencies-note"
          />
        </Field>
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Back</Button>
          <Button variant="primary" type="submit" disabled={busy} data-testid="save-dependencies">
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
