import { type FormEvent, useEffect, useState } from "react";
import { type CreateTaskInput, describeError, type TaskView } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../../components/ui.tsx";
import { chfMicroToUsdMicro, chfToMicro, type MoneyLike } from "../../lib/money.ts";
import { useClient } from "../../store/context.tsx";

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
  const [priority, setPriority] = useState(5);
  const [budget, setBudget] = useState("");
  const [status, setStatus] = useState<"draft" | "ready">("ready");
  const [dependsOn, setDependsOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(seed?.title ?? "");
    setOutcome(seed?.outcome ?? "");
    setStatus(seed?.status ?? "ready");
    setCriteria("");
    setBudget("");
    setDependsOn("");
    setRiskTier(PROJECT_DEFAULT_TIER);
    setPriority(5);
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
      dependsOn: dependsOn
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
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
          <Field label="Priority (1 high)">
            <input
              className={INPUT_CLASS}
              type="number"
              min={1}
              max={9}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              name="priority"
            />
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
        <Field label="Depends on" hint="Task ids, comma-separated.">
          <input
            className={INPUT_CLASS}
            value={dependsOn}
            onChange={(e) => setDependsOn(e.target.value)}
            name="dependsOn"
          />
        </Field>
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
