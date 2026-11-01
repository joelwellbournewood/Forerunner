import type { TaskView } from "../../api/client.ts";
import { displayOf } from "../../lib/task-actions.ts";

/** How a possible dependency's state reads in the picker: "done", else its status in words. */
function stateWords(t: TaskView): string {
  if (t.status === "done") return "done";
  if (t.status === "failed") return "failed";
  return `not done yet: ${displayOf(t).label}`;
}

/**
 * The tasks a task waits on, picked by title from the project's own tasks (U-040); the caller
 * puts it in a `<fieldset>` with its legend (checkbox labels cannot sit in a `Field`'s label).
 * Before, the New task dialog took task ids typed by hand, so a typo kept the task out of every
 * plan for good. A cancelled task is not offered (the daemon refuses it: it never finishes),
 * the task itself is not either, and a dependency that names no task any more stays listed,
 * checked, so the person can take it off. Each task says whether it is done, in words; ticking
 * a failed one says what that means (the walk: the picker took it silently).
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
  const failed = selected.map((id) => byId.get(id)).filter((t) => t?.status === "failed");
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
    <>
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
              {t.title} <span className="text-xs text-neutral-500">({stateWords(t)})</span>
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
              a task that no longer exists; untick it to remove it
            </span>
          </label>
        ))}
      </div>
      {failed.length > 0 ? (
        <p
          className="mt-1 text-xs text-amber-800 dark:text-amber-200"
          data-testid="dependency-failed"
        >
          {failed.map((t) => `"${t?.title}"`).join(", ")} failed: this task waits until{" "}
          {failed.length === 1 ? "it is" : "they are"} tried again and done.
        </p>
      ) : null}
    </>
  );
}

/**
 * How a task's dependencies read in a line (the Plan tab): by title, each one not done with its
 * state in words ("not done yet", "failed", "cancelled"), never a raw status or an id.
 */
export function describeDependencies(
  task: Pick<TaskView, "dependsOn">,
  byId: ReadonlyMap<string, Pick<TaskView, "title" | "status">>,
): string {
  return task.dependsOn
    .map((id) => {
      const dep = byId.get(id);
      if (!dep) return "a task that no longer exists";
      if (dep.status === "done") return `"${dep.title}"`;
      if (dep.status === "failed" || dep.status === "cancelled")
        return `"${dep.title}" (${dep.status})`;
      return `"${dep.title}" (not done yet)`;
    })
    .join(", ");
}
