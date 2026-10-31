import type { TaskView } from "../../api/client.ts";

/**
 * The tasks a task waits on, picked by title from the project's own tasks (U-040); the caller
 * puts it in a `<fieldset>` with its legend (checkbox labels cannot sit in a `Field`'s label).
 * Before, the
 * New task dialog took task ids typed by hand, so a typo kept the task out of every plan for
 * good. A cancelled task is not offered (the daemon refuses it: it never finishes), the task
 * itself is not either, and a dependency that names no task any more stays listed, checked,
 * so the person can take it off.
 */
export function DependencyPicker({
  tasks,
  selected,
  onChange,
  excludeId,
  loading,
}: {
  tasks: readonly TaskView[] | null;
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** The task being edited: it cannot wait on itself. */
  excludeId?: string;
  loading?: boolean;
}) {
  const byId = new Map((tasks ?? []).map((t) => [t.id, t]));
  const choices = (tasks ?? []).filter(
    (t) => t.id !== excludeId && (t.status !== "cancelled" || selected.includes(t.id)),
  );
  const missing = selected.filter((id) => !byId.has(id));
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...selected, id] : selected.filter((s) => s !== id));
  if (loading && !tasks) return <p className="text-xs text-neutral-500">Loading the tasks…</p>;
  if (choices.length === 0 && missing.length === 0)
    return (
      <p className="text-xs text-neutral-500" data-testid="dependency-none">
        No other task in this project to wait on.
      </p>
    );
  return (
    <div
      className="max-h-44 space-y-1 overflow-y-auto rounded border border-neutral-200 p-2 dark:border-neutral-700"
      data-testid="dependency-picker"
    >
      {choices.map((t) => (
        <label key={t.id} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={selected.includes(t.id)}
            onChange={(e) => toggle(t.id, e.target.checked)}
            data-testid="dependency-option"
            data-task-id={t.id}
          />
          <span>
            {t.title}{" "}
            <span className="text-xs text-neutral-500">
              ({t.status === "needs_human" ? "needs you" : t.status})
            </span>
          </span>
        </label>
      ))}
      {missing.map((id) => (
        <label key={id} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked
            onChange={(e) => toggle(id, e.target.checked)}
            data-testid="dependency-option"
            data-task-id={id}
          />
          <span className="text-amber-800 dark:text-amber-200">
            a task that does not exist ({id}); untick it to remove it
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * How a task's dependencies read on the Tasks tab (U-040): by title, and with the state of each
 * one not done, so a task waiting on a cancelled or failed one is visible as such.
 */
export function describeDependencies(
  task: Pick<TaskView, "dependsOn">,
  byId: ReadonlyMap<string, Pick<TaskView, "title" | "status">>,
): string {
  return task.dependsOn
    .map((id) => {
      const dep = byId.get(id);
      if (!dep) return `a task that does not exist (${id})`;
      return dep.status === "done" ? `"${dep.title}"` : `"${dep.title}" (${dep.status})`;
    })
    .join(", ");
}

/** True when a dependency will not finish by itself: cancelled, failed or missing. */
export function hasStuckDependency(
  task: Pick<TaskView, "dependsOn">,
  byId: ReadonlyMap<string, Pick<TaskView, "status">>,
): boolean {
  return task.dependsOn.some((id) => {
    const status = byId.get(id)?.status;
    return status === undefined || status === "cancelled" || status === "failed";
  });
}
