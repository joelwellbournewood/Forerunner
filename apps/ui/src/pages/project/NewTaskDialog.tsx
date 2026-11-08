import {
  DEFAULT_TASK_PRIORITY,
  PRIORITY_LABELS,
  readPriority,
  TASK_PRIORITIES,
  type TaskPriority,
} from "@forerunner/runtime/priority";
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { type CreateTaskInput, describeError, type TaskTransitionView } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../../components/ui.tsx";
import { chfMicroToUsdMicro, chfToMicro, type MoneyLike } from "../../lib/money.ts";
import {
  FULL_REVIEW_SPECIALISTS,
  FULL_REVIEW_TIER,
  reviewLevelChoices,
  reviewLevelName,
  WHO_AGENT,
  WHO_PERSON,
} from "../../lib/task-actions.ts";
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

/** The review level select's value for "leave it to the project": no `riskTier` is sent. */
export const PROJECT_DEFAULT_TIER = "";

/**
 * Whether the Docker sandbox is ready (`GET /sandbox`), for the review level's words: a full
 * review needs it (ADR 0101). Null while not known (or the daemon has no such route).
 */
export function useDockerReady(open: boolean): boolean | null {
  const client = useClient();
  const sandbox = useAsync(
    (signal) => (open ? client.sandboxStatus(signal) : Promise.resolve(null)),
    [client, open],
  );
  return sandbox.data ? sandbox.data.ready : null;
}

/**
 * "Who does it" (design §3.5): let the agent choose, one of the runnable specialists (with
 * what it is for), or "Me: ask me in the Inbox" (`person`: the task's questions come to the
 * person's Inbox, no specialist runs).
 */
export function useWhoChoices(
  open: boolean,
  projectId?: string,
): { value: string; label: string; limitation?: string | null; runsOn?: string | null }[] {
  const client = useClient();
  const models = useAsync(
    (signal) => (open ? client.modelSettings(signal, projectId) : Promise.resolve(null)),
    [client, open, projectId],
  );
  const specialists = (models.data?.specialists ?? []).map((s) => ({
    value: s.name,
    label: s.description ? `${s.name}: ${firstSentence(s.description)}` : s.name,
    // What it cannot do on this install, in the daemon's words (ADR 0107), said when chosen.
    limitation: s.limitation ?? null,
    // Where it runs for this project and why (U-078, the plan card's words), said when chosen.
    runsOn: s.runsOn?.line ?? null,
  }));
  return [
    { value: WHO_AGENT, label: "Let the agent choose" },
    ...specialists,
    { value: WHO_PERSON, label: "Me: ask me in the Inbox" },
  ];
}

function firstSentence(text: string): string {
  const s = text.split(/(?<=\.)\s/)[0] ?? text;
  return s.length > 70 ? `${s.slice(0, 69)}…` : s;
}

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
   * 0 in small-project mode, spec B.6), named on the "project default" option; the dialog
   * never computes it.
   */
  defaultRiskTier?: number;
  onCreated: (task: TaskTransitionView) => void;
}) {
  const client = useClient();
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [criteria, setCriteria] = useState("");
  const [riskTier, setRiskTier] = useState(PROJECT_DEFAULT_TIER);
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [budget, setBudget] = useState("");
  const [who, setWho] = useState(WHO_AGENT);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const docker = useDockerReady(open);
  const whoChoices = useWhoChoices(open, projectId);
  const whoChoice = whoChoices.find((w) => w.value === who);
  // The chooser's sentence (U-078) says what the limitation would; one note, never both.
  const whoRunsOn = whoChoice?.runsOn ?? null;
  const whoLimitation = whoRunsOn ? null : (whoChoice?.limitation ?? null);
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
    setCriteria("");
    setBudget("");
    setDependsOn([]);
    setRiskTier(PROJECT_DEFAULT_TIER);
    setPriority(DEFAULT_TASK_PRIORITY);
    setWho(WHO_AGENT);
    setError(null);
  }, [open, seed]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const chf = budget.trim() ? chfToMicro(budget) : null;
    if (budget.trim() && chf === null) {
      setError("The budget is an amount in CHF, like 2.40 or 2,40.");
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
      // Only a level the person picked is sent; otherwise the daemon applies the project's. A
      // deploy or a migration sends the full review it keeps (the daemon raises it too).
      ...(keepsFull
        ? { riskTier: tier }
        : riskTier === PROJECT_DEFAULT_TIER
          ? {}
          : { riskTier: Number(riskTier) }),
      priority,
      status: seed?.status ?? "ready",
      dependsOn,
      budgetUsdMicro: chf !== null ? chfMicroToUsdMicro(chf, reference) : 0,
      ...(who === WHO_AGENT ? {} : { specialist: who }),
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

  // A deploy or a migration keeps the full review and the person's sign-off (ADR 0104, the
  // owner's decision 4; phase C leftover C-2): no light review is offered for it, as in Edit.
  const keepsFull = FULL_REVIEW_SPECIALISTS.has(who);
  const chosen = riskTier === PROJECT_DEFAULT_TIER ? (defaultRiskTier ?? 1) : Number(riskTier);
  const tier = keepsFull ? Math.max(chosen, FULL_REVIEW_TIER) : chosen;
  const fullWithoutDocker = tier >= 2 && docker === false;
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
        <Field label="What done looks like">
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
        <Field label="Criteria (optional)" hint="One per line; the critic checks each.">
          <textarea
            className={`${INPUT_CLASS} min-h-16`}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            name="criteria"
            data-testid="task-criteria"
          />
        </Field>
        <fieldset className="text-sm">
          <legend className="mb-1 block font-medium">Waits for</legend>
          <DependencyPicker
            tasks={projectTasks.data}
            loading={projectTasks.loading}
            selected={dependsOn}
            onChange={setDependsOn}
          />
          <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
            The tasks that must be done before this one runs.
          </span>
        </fieldset>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Review level">
            <select
              className={INPUT_CLASS}
              value={keepsFull ? String(tier) : riskTier}
              onChange={(e) => setRiskTier(e.target.value)}
              name="riskTier"
              data-testid="task-risk-tier"
            >
              {keepsFull ? null : (
                <option value={PROJECT_DEFAULT_TIER}>
                  The project's default
                  {defaultRiskTier === undefined ? "" : ` (${reviewLevelName(defaultRiskTier)})`}
                </option>
              )}
              {reviewLevelChoices(docker)
                .filter((c) => !keepsFull || c.tier >= FULL_REVIEW_TIER)
                .map((c) => (
                  <option key={c.tier} value={String(c.tier)}>
                    {c.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Who does it">
            <select
              className={INPUT_CLASS}
              value={who}
              onChange={(e) => setWho(e.target.value)}
              name="who"
              data-testid="task-who"
            >
              {whoChoices.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
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
          <Field
            label="Budget (CHF, optional)"
            hint="Empty: each run stops at its specialist's limit."
          >
            <input
              className={INPUT_CLASS}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
              name="budget"
              data-testid="task-budget"
            />
          </Field>
        </div>
        {keepsFull ? (
          <p className="text-sm" data-testid="task-full-review-note">
            {FULL_REVIEW_SPECIALISTS.get(who)} keeps the full review and your sign-off.
          </p>
        ) : null}
        {fullWithoutDocker ? (
          <p className="text-sm text-amber-800 dark:text-amber-200" data-testid="task-docker-note">
            Full review needs Docker, which is not running on this computer: the task waits until it
            runs. <Link to="/settings">Settings</Link> has the steps.
          </p>
        ) : null}
        {whoRunsOn ? (
          <p className="text-sm" data-testid="task-who-note">
            {whoRunsOn}
          </p>
        ) : whoLimitation ? (
          <p className="text-sm text-amber-800 dark:text-amber-200" data-testid="task-who-note">
            {`${whoLimitation}: the ${who} works only from the project's files.`}
          </p>
        ) : null}
        {who === WHO_PERSON ? (
          <p className="text-sm" data-testid="task-person-note">
            No specialist runs it: its questions come to your Inbox.
          </p>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy} data-testid="create-task">
            {busy ? "Adding…" : "Add task"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
