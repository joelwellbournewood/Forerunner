import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { describeError } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../../components/ui.tsx";
import { chfMicroToUsdMicro, chfToMicro, type MoneyLike } from "../../lib/money.ts";
import { useClient, useIdentity } from "../../store/context.tsx";

/** Start a session for the project -> POST /sessions, then open the live view. */
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
    try {
      const session = await client.startSession({
        agentId: identity.agentId,
        projectId,
        trigger: "manual",
        budgetUsdMicro: chf !== null && chf > 0 ? chfMicroToUsdMicro(chf, reference) : undefined,
        reason: reason.trim() || undefined,
      });
      setBudget("");
      setReason("");
      onClose();
      navigate(`/sessions/${encodeURIComponent(session.id)}`);
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
        {error ? <ErrorBanner message={error} /> : null}
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
