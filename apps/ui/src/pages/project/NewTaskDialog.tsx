import {
  DEFAULT_TASK_PRIORITY,
  PRIORITY_LABELS,
  readPriority,
  TASK_PRIORITIES,
  type TaskPriority,
} from "@forerunner/runtime/priority";
import { type FormEvent, useEffect, useState } from "react";
import { type CreateTaskInput, describeError, type TaskView } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../../components/ui.tsx";
import { chfMicroToUsdMicro, chfToMicro, type MoneyLike } from "../../lib/money.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";
import { DependencyPicker } from "./DependencyPicker.tsx";

/** Prefill for "make this a task" from chat: a ready task with the message as the outcome (U-016). */
export interface TaskSeed {
  title: string;
  outcome: string;
  status?: "draft" | "ready";
}

export function seedFromMessage(text: string): TaskSeed {
  const firstLine =
    text
      .split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "Task";
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  return {
    title: title.length >= 3 ? title : `${title} (from chat)`,
    outcome: text.trim(),
    status: "ready",
  };
}

/** The tier select's value for "leave it to the project": no `riskTier` is sent. */
export const PROJECT_DEFAULT_TIER = "";

export function NewTaskDialog({
  open,
  onClose,
  projectId,
  seed,
  reference,
  defaultRiskTier,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  seed?: TaskSeed | null;
  /** Money pair carrying the day's rate for the CHF budget field. */
  reference?: MoneyLike;
  /**
   * The tier the daemon gives a task that names none (the project card's `defaultRiskTier`:
   * 0 in small-project mode, spec B.6), shown on the "project default" option; the dialog
   * never computes it.
   */
  defaultRiskTier?: number;
  onCreated: (task: TaskView) => void;
}) {
  const client = useClient();
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [criteria, setCriteria] = useState("");
  const [riskTier, setRiskTier] = useState(PROJECT_DEFAULT_TIER);
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [budget, setBudget] = useState("");
  const [status, setStatus] = useState<"draft" | "ready">("ready");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  // The tasks it may wait on, by title (U-040): picked, never typed as ids.
  const projectTasks = useAsync(
    (signal) => (open ? client.tasks(projectId, { limit: 500 }, signal) : Promise.resolve(null)),
    [client, projectId, open],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(seed?.title ?? "");
    setOutcome(seed?.outcome ?? "");
    setStatus(seed?.status ?? "ready");
    setCriteria("");
    setBudget("");
    setDependsOn([]);
    setRiskTier(PROJECT_DEFAULT_TIER);
    setPriority(DEFAULT_TASK_PRIORITY);
    setError(null);
  }, [open, seed]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const chf = budget.trim() ? chfToMicro(budget) : null;
    if (budget.trim() && chf === null) {
      setError("Budget must be a number of CHF.");
      return;
    }
    setBusy(true);
    setError(null);
    const body: CreateTaskInput = {
      title: title.trim(),
      outcome: outcome.trim(),
      acceptanceCriteria: criteria
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
      // Only a tier the human picked is sent; otherwise the daemon applies the project's.
      ...(riskTier === PROJECT_DEFAULT_TIER ? {} : { riskTier: Number(riskTier) }),
      priority,
      status,
      dependsOn,
      budgetUsdMicro: chf !== null ? chfMicroToUsdMicro(chf, reference) : 0,
    };
    try {
      const task = await client.createTask(projectId, body);
      onCreated(task);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New task" testId="new-task-dialog" wide>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Title">
          <input
            className={INPUT_CLASS}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            minLength={3}
            name="title"
            data-testid="task-title"
          />
        </Field>
        <Field label="Outcome" hint="What is true when the task is done.">
          <textarea
            className={`${INPUT_CLASS} min-h-20`}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            required
            minLength={3}
            name="outcome"
            data-testid="task-outcome"
          />
        </Field>
        <Field label="Acceptance criteria" hint="One per line.">
          <textarea
            className={`${INPUT_CLASS} min-h-16`}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            name="criteria"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Risk tier" hint="The project default applies unless you pick one.">
            <select
              className={INPUT_CLASS}
              value={riskTier}
              onChange={(e) => setRiskTier(e.target.value)}
              name="riskTier"
              data-testid="task-risk-tier"
            >
              <option value={PROJECT_DEFAULT_TIER}>
                project default{defaultRiskTier === undefined ? "" : ` (tier ${defaultRiskTier})`}
              </option>
              {[0, 1, 2, 3].map((t) => (
                <option key={t} value={String(t)}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority" hint="High runs first.">
            <select
              className={INPUT_CLASS}
              value={priority}
              onChange={(e) => setPriority(readPriority(e.target.value) ?? DEFAULT_TASK_PRIORITY)}
              name="priority"
              data-testid="task-priority"
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Budget (CHF)">
            <input
              className={INPUT_CLASS}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
              placeholder="0 = project default"
              name="budget"
            />
          </Field>
          <Field label="Status">
            <select
              className={INPUT_CLASS}
              value={status}
              onChange={(e) => setStatus(e.target.value === "draft" ? "draft" : "ready")}
              name="status"
              data-testid="task-status"
            >
              <option value="ready">ready</option>
              <option value="draft">draft</option>
            </select>
          </Field>
        </div>
        <fieldset className="text-sm">
          <legend className="mb-1 block font-medium">Depends on</legend>
          <DependencyPicker
            tasks={projectTasks.data}
            loading={projectTasks.loading}
            selected={dependsOn}
            onChange={setDependsOn}
          />
          <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
            The tasks that must be done before this one runs. Change them later on the Tasks tab.
          </span>
        </fieldset>
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy} data-testid="create-task">
            {busy ? "Creating…" : "Create task"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
