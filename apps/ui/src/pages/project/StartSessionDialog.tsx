import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { describeError, type StartCheckView, type StartSessionView } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS, Money } from "../../components/ui.tsx";
import { chfMicroToUsdMicro, chfToMicro, type MoneyLike } from "../../lib/money.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient, useIdentity } from "../../store/context.tsx";

/**
 * What the dialog says when the start did not hand back a session to open (U-003). A waiting
 * start runs in order behind the ones already waiting, never replaced (U-043), so the notice
 * says how many come first.
 */
export function startNotice(result: StartSessionView["result"], ahead = 0): string {
  const before =
    ahead === 1
      ? "1 other start waits before this one; they run one after the other, in order."
      : `${ahead} other starts wait before this one; they run one after the other, in order.`;
  switch (result) {
    case "queued":
      return ahead > 0
        ? `Queued: your agent is in another session, and ${before} This one starts after them.`
        : "Queued: your agent is in another session. This one starts when that one ends.";
    case "deferred":
      return ahead > 0
        ? `Deferred: it is quiet hours, and ${before} This one starts after them, once the quiet hours end.`
        : "Deferred: it is quiet hours. The session starts when they end.";
    default:
      return "Starting: the session appears under Sessions in a moment.";
  }
}

/** How the dialog names what a waiting task waits on (U-040). */
export function waitsOnText(waitsOn: StartCheckView["waiting"][number]["waitsOn"]): string {
  return waitsOn
    .map((d) =>
      d.title === null
        ? `a task that does not exist (${d.taskId})`
        : `"${d.title}" (${d.status === "needs_human" ? "needs you" : d.status})`,
    )
    .join(" and ");
}

/** True when a waiting task waits on one that never finishes by itself (U-040). */
function stuck(w: StartCheckView["waiting"][number]): boolean {
  return w.waitsOn.some(
    (d) => d.status === null || d.status === "cancelled" || d.status === "failed",
  );
}

/**
 * The tasks a session started now would not run (U-040): the ones waiting on another task and
 * the ones that do not fit the work budget, each by title with what holds it back.
 */
function NotInThisSession({ check }: { check: StartCheckView }) {
  return (
    <ul className="mt-1 list-disc pl-5">
      {check.waiting.map((w) => (
        <li key={w.taskId} data-testid="start-session-waiting">
          "{w.title}" waits on {waitsOnText(w.waitsOn)}
          {stuck(w)
            ? ": that will not be done by itself. Change what it depends on (Tasks tab, Depends on…) or mark the failed task ready again."
            : "."}
        </li>
      ))}
      {check.overBudget.map((t) => (
        <li key={t.taskId} data-testid="start-session-over-budget">
          "{t.title}" needs about <Money value={t.estimate} />, more than this session's work budget
          of <Money value={check.workBudget} /> (the budget less a fifth kept for reviews). Give the
          session a larger budget, or the task a smaller one.
        </li>
      ))}
    </ul>
  );
}

/**
 * Start a session for the project -> POST /sessions, then open the live view of the session the
 * start began, or say why there is none yet (queued, deferred, still starting).
 */
export function StartSessionDialog({
  open,
  onClose,
  projectId,
  reference,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** A Money pair that carries the day's rate for the CHF budget input. */
  reference: MoneyLike;
}) {
  const client = useClient();
  const identity = useIdentity();
  const navigate = useNavigate();
  const [budget, setBudget] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A session works only on ready tasks it can run (U-009, U-040): look before the human starts
  // one for nothing, with the budget typed so far (the project's cap while it is empty).
  const typedChf = budget.trim() ? chfToMicro(budget) : null;
  const budgetUsdMicro =
    typedChf !== null && typedChf > 0 ? chfMicroToUsdMicro(typedChf, reference) : undefined;
  const check = useAsync(
    (signal) =>
      open ? client.startCheck(projectId, { budgetUsdMicro }, signal) : Promise.resolve(null),
    [client, projectId, open, budgetUsdMicro],
  );
  const noReadyTask = check.data !== null && check.data.ready === 0;
  const nothingRuns = check.data !== null && !noReadyTask && check.data.runnable.length === 0;
  const someLeftOut =
    check.data !== null &&
    !noReadyTask &&
    !nothingRuns &&
    check.data.waiting.length + check.data.overBudget.length > 0;
  useEffect(() => {
    if (!open) setNotice(null);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !identity) return;
    const chf = budget.trim() ? chfToMicro(budget) : null;
    if (budget.trim() && chf === null) {
      setError("Budget must be a number of CHF.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const started = await client.startSession({
        agentId: identity.agentId,
        projectId,
        trigger: "manual",
        budgetUsdMicro: chf !== null && chf > 0 ? chfMicroToUsdMicro(chf, reference) : undefined,
        reason: reason.trim() || undefined,
      });
      setBudget("");
      setReason("");
      if (started.session) {
        onClose();
        navigate(`/sessions/${encodeURIComponent(started.session.id)}`);
      } else {
        setNotice(startNotice(started.result, started.ahead));
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Start a session" testId="start-session-dialog">
      <form onSubmit={submit} className="space-y-3">
        <Field
          label="Session budget (CHF)"
          hint="Leave empty for the project default. Converted at the day's rate."
        >
          <input
            className={INPUT_CLASS}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            inputMode="decimal"
            placeholder="e.g. 5.00"
            name="budget"
          />
        </Field>
        <Field label="Reason" hint="Shown in the session log and the handoff.">
          <input
            className={INPUT_CLASS}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            name="reason"
          />
        </Field>
        {!identity ? (
          <p className="text-xs text-neutral-500">Waiting for the daemon to report your agent…</p>
        ) : null}
        {noReadyTask ? (
          <div
            role="note"
            className="rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            data-testid="start-session-no-work"
          >
            <p className="font-medium">No task in this project is ready.</p>
            <p className="mt-1">
              A session works only on ready tasks, so it would end at once and spend nothing. Give
              your agent work first:
            </p>
            <ul className="mt-1 list-disc pl-5">
              <li>add a task in the Tasks tab;</li>
              <li>or click Mark ready on a draft task there (a session skips drafts);</li>
              <li>or ask in Chat, for example "add a task: write the README";</li>
              <li>or approve the plan waiting in the Inbox, if you gave a brief.</li>
            </ul>
          </div>
        ) : null}
        {nothingRuns && check.data ? (
          <div
            role="note"
            className="rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            data-testid="start-session-cannot-run"
          >
            <p className="font-medium">
              {check.data.ready === 1
                ? "The ready task cannot run in this session."
                : `None of the ${check.data.ready} ready tasks can run in this session.`}
            </p>
            <p className="mt-1">A session would plan nothing and end at once:</p>
            <NotInThisSession check={check.data} />
          </div>
        ) : null}
        {someLeftOut && check.data ? (
          <div
            role="note"
            className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
            data-testid="start-session-left-out"
          >
            <p className="font-medium">Not in this session:</p>
            <NotInThisSession check={check.data} />
          </div>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        {notice ? (
          <p
            role="status"
            className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
            data-testid="start-session-notice"
          >
            {notice}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !identity}
            data-testid="confirm-start-session"
          >
            {busy ? "Starting…" : "Start"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
