import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { describeError, type StartSessionView } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../../components/ui.tsx";
import { chfMicroToUsdMicro, chfToMicro, type MoneyLike } from "../../lib/money.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient, useIdentity } from "../../store/context.tsx";

/** What the dialog says when the start did not hand back a session to open (U-003). */
export function startNotice(result: StartSessionView["result"]): string {
  switch (result) {
    case "queued":
      return "Queued: your agent is in another session. This one starts when that one ends.";
    case "deferred":
      return "Deferred: it is quiet hours. The session starts when they end.";
    default:
      return "Starting: the session appears under Sessions in a moment.";
  }
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
  // A session works only on ready tasks (U-009): look before the human starts one for nothing.
  const ready = useAsync(
    (signal) =>
      open ? client.tasks(projectId, { status: "ready", limit: 1 }, signal) : Promise.resolve(null),
    [client, projectId, open],
  );
  const noReadyTask = Array.isArray(ready.data) && ready.data.length === 0;
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
        setNotice(startNotice(started.result));
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
              <li>or ask in Chat, for example "add a task: write the README";</li>
              <li>or approve the plan waiting in the Inbox, if you gave a brief.</li>
            </ul>
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
