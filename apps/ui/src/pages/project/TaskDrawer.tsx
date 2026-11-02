import {
  DEFAULT_TASK_PRIORITY,
  PRIORITY_LABELS,
  TASK_PRIORITIES,
} from "@forerunner/runtime/priority";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import {
  describeError,
  type TaskDetailView,
  type TaskReviewEvidence,
  type TaskTransitionView,
  type TaskView,
  type UpdateTaskInput,
} from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { ExternalLink } from "../../components/ExternalLink.tsx";
import { RichText } from "../../components/RichText.tsx";
import {
  Badge,
  Button,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
  Money,
} from "../../components/ui.tsx";
import {
  chfMicroToUsdMicro,
  chfToMicro,
  formatAmount,
  type MoneyLike,
  usdMicroToChfMicro,
} from "../../lib/money.ts";
import {
  ACTIONS,
  actionsFor,
  displayOf,
  FULL_REVIEW_SPECIALISTS,
  FULL_REVIEW_TIER,
  reviewLevelChoices,
  reviewLevelName,
  reviewLevelValue,
  type TaskActionKey,
  WHO_AGENT,
  whoName,
} from "../../lib/task-actions.ts";
import { formatDateTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";
import { useDockerReady, useWhoChoices } from "./NewTaskDialog.tsx";

/**
 * The task drawer (design §3.5): what the task asks for (outcome, criteria), what it waits for
 * and what waits on it, its runs (who ran it, the report or error, the files changed), the
 * critic's review in words, its open Inbox cards and the PR; every action of its status with
 * its one-line explanation beside it; Edit in place. Opened by a click on a task's title; the
 * address keeps it (`?task=`), so a reload opens it again.
 */
export function TaskDrawer({
  taskId,
  tasks,
  reference,
  onClose,
  onAction,
  onChanged,
}: {
  taskId: string | null;
  tasks: readonly TaskView[];
  reference?: MoneyLike;
  onClose: () => void;
  onAction: (task: TaskView, action: TaskActionKey) => void;
  onChanged: (r: TaskTransitionView) => void;
}) {
  const client = useClient();
  const row = tasks.find((t) => t.id === taskId);
  // Read again whenever the row changes (an action, a session moved it).
  const detail = useAsync(
    (signal) => (taskId ? client.task(taskId, signal) : Promise.resolve(null)),
    [client, taskId, row?.version, row?.status],
  );
  const [editing, setEditing] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  if (shown !== taskId) {
    setShown(taskId);
    setEditing(false);
  }
  if (!taskId) return null;
  const d = detail.data;
  const task = row ?? d?.task;
  return (
    <Dialog open onClose={onClose} title={task?.title ?? "Task"} testId="task-drawer" wide>
      {!d && detail.loading ? <Loading what="the task" /> : null}
      {detail.error && !d ? <ErrorBanner message={detail.error} onRetry={detail.reload} /> : null}
      {task && d ? (
        editing ? (
          <EditTaskForm
            task={task}
            reference={reference}
            onCancel={() => setEditing(false)}
            onSaved={(r) => {
              onChanged(r);
              setEditing(false);
              detail.reload();
            }}
          />
        ) : (
          <DrawerBody
            task={task}
            detail={d}
            onAction={(key) => (key === "edit" ? setEditing(true) : onAction(task, key))}
          />
        )
      ) : null}
    </Dialog>
  );
}

function DrawerBody({
  task,
  detail,
  onAction,
}: {
  task: TaskView;
  detail: TaskDetailView;
  onAction: (key: TaskActionKey) => void;
}) {
  const d = displayOf(task);
  const prUrl = task.prUrl;
  return (
    <div className="space-y-4 text-sm" data-testid="task-drawer-body">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={d.tone} testId="drawer-status">
          {d.label}
        </Badge>
        <span className="text-xs text-neutral-500">
          {reviewLevelName(task.riskTier)} · {PRIORITY_LABELS[task.priority]} priority ·{" "}
          {whoName(task.specialist)} · spent <Money value={task.actual} />
        </span>
      </div>
      {d.detail ? <p className="text-neutral-700 dark:text-neutral-300">{d.detail}</p> : null}

      <section data-testid="drawer-asks">
        <h3 className="font-medium">What done looks like</h3>
        <p className="whitespace-pre-wrap">{task.outcome || "Not said."}</p>
        {task.acceptanceCriteria.length > 0 ? (
          <ul className="mt-1 list-disc pl-5" data-testid="drawer-criteria">
            {task.acceptanceCriteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section data-testid="drawer-actions">
        <h3 className="font-medium">What you can do</h3>
        <ul className="mt-1 space-y-1">
          {actionsFor(d.key, task).map((key) => (
            <li key={key} className="flex flex-wrap items-baseline gap-2">
              <Button
                variant={key === "cancel" ? "ghost" : "secondary"}
                className="px-2 py-0.5 text-xs"
                onClick={() => onAction(key)}
                data-testid={`drawer-action-${key}`}
              >
                {ACTIONS[key].label}
              </Button>
              <span className="text-xs text-neutral-600 dark:text-neutral-400">
                {ACTIONS[key].explain}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {detail.waitsOn.length > 0 || detail.waitedOnBy.length > 0 ? (
        <section data-testid="drawer-waits">
          {detail.waitsOn.length > 0 ? (
            <>
              <h3 className="font-medium">It waits for</h3>
              <ul className="list-disc pl-5">
                {detail.waitsOn.map((w) => (
                  <li key={w.taskId}>
                    {w.title ? `"${w.title}"` : "A task that no longer exists"}: {w.status}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {detail.waitedOnBy.length > 0 ? (
            <>
              <h3 className="mt-2 font-medium">Waiting on it</h3>
              <ul className="list-disc pl-5">
                {detail.waitedOnBy.map((w) => (
                  <li key={w.taskId}>"{w.title}"</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {detail.cards.length > 0 ? (
        <section data-testid="drawer-cards">
          <h3 className="font-medium">In your Inbox</h3>
          <ul className="list-disc pl-5">
            {detail.cards.map((c) => (
              <li key={c.requestId}>
                {c.question}{" "}
                <Link to="/inbox" className="text-blue-700 hover:underline dark:text-blue-300">
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section data-testid="drawer-runs">
        <h3 className="font-medium">Runs</h3>
        {detail.runs.length === 0 ? (
          <p className="text-neutral-500">No run yet.</p>
        ) : (
          <ul className="space-y-2">
            {detail.runs.map((r) => (
              <li
                key={r.id}
                className="rounded border border-neutral-200 p-2 dark:border-neutral-800"
                data-testid="drawer-run"
                data-kind={r.kind}
              >
                <div className="text-xs text-neutral-500">
                  {/* The critic's run is its review of the work (its words are under Review). */}
                  {r.kind === "review" ? "Review by the critic" : whoName(r.specialist)} ·{" "}
                  {formatDateTime(r.startedAt)} · {r.outcome} · <Money value={r.cost} />
                </div>
                {r.report ? <RichText text={r.report} className="mt-1" /> : null}
                {r.files.length > 0 ? (
                  <p className="mt-1 text-xs" data-testid="drawer-files">
                    Changed: {r.files.join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.review ? (
        <section data-testid="drawer-review">
          <h3 className="font-medium">Review</h3>
          {detail.review.check ? (
            <p data-testid="drawer-check">
              <Badge tone="good">{detail.review.check.label}</Badge>{" "}
              {detail.review.check.tried
                ? "The critic read the work and it was opened as you would open it."
                : "The critic read the work against each point above."}
            </p>
          ) : (
            <p>{detail.review.verdict}</p>
          )}
          {detail.review.summary ? (
            <RichText
              text={detail.review.summary}
              className="text-neutral-700 dark:text-neutral-300"
            />
          ) : null}
          {detail.review.open.length > 0 ? (
            <ul className="list-disc pl-5">
              {detail.review.open.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
          {detail.review.evidence ? (
            <ReviewEvidence taskId={task.id} evidence={detail.review.evidence} />
          ) : null}
          <Link
            to={`/projects/${encodeURIComponent(task.projectId)}/reviews?review=${encodeURIComponent(detail.review.id)}`}
            className="text-xs text-blue-700 hover:underline dark:text-blue-300"
            data-testid="review-link"
          >
            The whole review
          </Link>
        </section>
      ) : null}

      {prUrl ? (
        <p>
          <ExternalLink href={prUrl} variant="inline" testId="drawer-pr-link">
            Its pull request
          </ExternalLink>
        </p>
      ) : null}
    </div>
  );
}

/**
 * What was run and tried for the review (ADR 0104), one click away: the project's checks with
 * the end of their output, each page tried with what a person would meet and its screenshots,
 * and what could not be run and why. Screenshots load when the evidence is opened.
 */
function ReviewEvidence({ taskId, evidence }: { taskId: string; evidence: TaskReviewEvidence }) {
  const [open, setOpen] = useState(false);
  const count = evidence.checks.length + evidence.tried.length + evidence.notChecked.length;
  if (count === 0) return null;
  return (
    <details
      className="mt-2 rounded border border-neutral-200 p-2 dark:border-neutral-700"
      data-testid="review-evidence"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-sm font-medium">See what was checked</summary>
      {evidence.checks.length ? (
        <div className="mt-2 space-y-1" data-testid="evidence-checks">
          <h4 className="text-xs font-medium text-neutral-500">The project's checks</h4>
          {evidence.checks.map((c) => (
            <div key={c.name}>
              <p>
                {c.name}: {c.passed ? "passed" : "failed"}
              </p>
              {c.output ? (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-neutral-100 p-1 text-xs dark:bg-neutral-800">
                  {c.output}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {evidence.tried.length ? (
        <div className="mt-2 space-y-2" data-testid="evidence-tried">
          <h4 className="text-xs font-medium text-neutral-500">Tried as you would use it</h4>
          {evidence.tried.map((t) => (
            <div key={t.target}>
              <p>
                {t.target}: {t.ok ? "worked" : "had a problem"}
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-neutral-100 p-1 text-xs dark:bg-neutral-800">
                {t.output}
              </pre>
              {open ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  {t.screenshots.map((sh) => (
                    <EvidenceShot key={sh.file} taskId={taskId} file={sh.file} label={sh.label} />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {evidence.notChecked.length ? (
        <ul
          className="mt-2 list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-400"
          data-testid="evidence-not-checked"
        >
          {evidence.notChecked.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

/** One screenshot of a try, read from the daemon (the image needs the daemon's token). */
function EvidenceShot({ taskId, file, label }: { taskId: string; file: string; label: string }) {
  const client = useClient();
  const shot = useAsync(
    (signal) => client.taskEvidence(taskId, file, signal),
    [client, taskId, file],
  );
  return (
    <figure className="w-full max-w-xs">
      {shot.data ? (
        <img
          src={`data:${shot.data.contentType};base64,${shot.data.base64}`}
          alt={`The page, ${label}`}
          className="w-full rounded border border-neutral-200 dark:border-neutral-700"
          data-testid="evidence-screenshot"
        />
      ) : shot.error ? (
        <p className="text-xs text-neutral-500">The screenshot could not be read.</p>
      ) : (
        <Loading what="the screenshot" />
      )}
      <figcaption className="text-xs text-neutral-500">{label}</figcaption>
    </figure>
  );
}

/** Edit (design §3.5): the wording, criteria, priority, budget, review level and who does it. */
function EditTaskForm({
  task,
  reference,
  onCancel,
  onSaved,
}: {
  task: TaskView;
  reference?: MoneyLike;
  onCancel: () => void;
  onSaved: (r: TaskTransitionView) => void;
}) {
  const client = useClient();
  const docker = useDockerReady(true);
  const who = useWhoChoices(true);
  const [title, setTitle] = useState(task.title);
  const [outcome, setOutcome] = useState(task.outcome);
  const [criteria, setCriteria] = useState(task.acceptanceCriteria.join("\n"));
  const [priority, setPriority] = useState<string>(task.priority ?? DEFAULT_TASK_PRIORITY);
  // The level the person chose; null while they leave it as it is.
  const [tier, setTier] = useState<string | null>(null);
  const [budget, setBudget] = useState(
    task.budget.usdMicro > 0
      ? formatAmount(usdMicroToChfMicro(task.budget.usdMicro, reference ?? task.budget))
      : "",
  );
  const [specialist, setSpecialist] = useState(task.specialist ?? WHO_AGENT);
  // What the select shows: the stored level (a stored tier 0 is the light review, ADR 0104), or
  // the one chosen, never below what the chosen specialist keeps (a deploy or a migration keeps
  // the full review, the owner's decision 4).
  const level = reviewLevelValue(tier === null ? task.riskTier : Number(tier), specialist);
  const keepsFull = FULL_REVIEW_SPECIALISTS.has(specialist);
  // What Save sends: a level left as it is goes back as stored, unless the specialist keeps the
  // full review and the task is below it; then it is raised, and the form says so.
  const sentTier =
    tier === null ? Math.max(task.riskTier, keepsFull ? FULL_REVIEW_TIER : 0) : level;
  const raised = keepsFull && sentTier > task.riskTier && task.riskTier < FULL_REVIEW_TIER;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const chf = budget.trim() ? chfToMicro(budget) : 0;
    if (chf === null) {
      setError("The budget is an amount in CHF, like 2.40 or 2,40.");
      return;
    }
    const body: UpdateTaskInput = {
      version: task.version,
      title: title.trim(),
      outcome: outcome.trim(),
      acceptanceCriteria: criteria
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
      priority: priority as UpdateTaskInput["priority"],
      riskTier: sentTier,
      budgetUsdMicro: chf > 0 ? chfMicroToUsdMicro(chf, reference ?? task.budget) : 0,
      specialist: specialist === WHO_AGENT ? null : specialist,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      onSaved(await client.updateTask(task.id, body));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const fullWithoutDocker = level >= FULL_REVIEW_TIER && docker === false;
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="edit-task-form">
      <p className="text-sm">{ACTIONS.edit.explain}</p>
      <Field label="Title">
        <input
          className={INPUT_CLASS}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          minLength={3}
          data-testid="edit-title"
        />
      </Field>
      <Field label="What done looks like">
        <textarea
          className={`${INPUT_CLASS} min-h-16`}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          required
          minLength={3}
          data-testid="edit-outcome"
        />
      </Field>
      <Field label="Criteria (optional)" hint="One per line.">
        <textarea
          className={`${INPUT_CLASS} min-h-16`}
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          data-testid="edit-criteria"
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Review level">
          <select
            className={INPUT_CLASS}
            value={String(level)}
            onChange={(e) => setTier(e.target.value)}
            data-testid="edit-risk-tier"
          >
            {reviewLevelChoices(docker)
              .filter((c) => !keepsFull || c.tier >= FULL_REVIEW_TIER)
              .map((c) => (
                <option key={c.tier} value={String(c.tier)}>
                  {c.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Priority" hint="High runs first.">
          <select
            className={INPUT_CLASS}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            data-testid="edit-priority"
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
            data-testid="edit-budget"
          />
        </Field>
        <Field label="Who does it">
          <select
            className={INPUT_CLASS}
            value={specialist}
            onChange={(e) => setSpecialist(e.target.value)}
            data-testid="edit-who"
          >
            {who.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {raised ? (
        <p className="text-sm" data-testid="edit-full-review-note">
          {FULL_REVIEW_SPECIALISTS.get(specialist)} keeps the full review and your sign-off: saving
          moves this task to the full review.
        </p>
      ) : null}
      {fullWithoutDocker ? (
        <p className="text-sm text-amber-800 dark:text-amber-200" data-testid="edit-docker-note">
          Full review needs Docker, which is not running on this computer: the task waits until it
          runs. <Link to="/settings">Settings</Link> has the steps.
        </p>
      ) : null}
      <Field label="Note for the agent (optional)" hint="Goes into the task's next brief.">
        <input
          className={INPUT_CLASS}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="edit-note"
        />
      </Field>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Back</Button>
        <Button variant="primary" type="submit" disabled={busy} data-testid="save-task">
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
