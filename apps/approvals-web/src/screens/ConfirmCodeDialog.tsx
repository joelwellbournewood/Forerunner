import { type FormEvent, useState } from "react";
import type { ConfirmChallengeView } from "../api/types.ts";
import { Banner, Button, Dialog } from "../components/ui.tsx";

/**
 * The web stand-in for the phone's biometric step (spec R.7, ADR 0009): a high-risk answer
 * needs a fresh one-time code that the service sends through the notification channel, and
 * the human re-enters it here. The code is never the link's code and never reused.
 */
export type ConfirmState =
  | { kind: "requesting" }
  | { kind: "enter"; challenge: ConfirmChallengeView; error: string | null }
  | { kind: "sending"; challenge: ConfirmChallengeView }
  | { kind: "unavailable"; message: string };

export function ConfirmCodeDialog({
  open,
  state,
  onSubmit,
  onNewCode,
  onClose,
}: {
  open: boolean;
  state: ConfirmState;
  onSubmit: (code: string) => void;
  onNewCode: () => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed) onSubmit(trimmed);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Confirm with a fresh code" testId="confirm-dialog">
      {state.kind === "requesting" && (
        <p className="text-sm" data-testid="confirm-requesting">
          Asking the state service for a code…
        </p>
      )}
      {state.kind === "unavailable" && (
        <div className="space-y-3">
          <Banner tone="error" testId="confirm-unavailable">
            {state.message}
          </Banner>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      )}
      {(state.kind === "enter" || state.kind === "sending") && (
        <form onSubmit={submit} className="space-y-3" data-testid="confirm-form">
          <p className="text-sm">
            This is a high-risk answer. A fresh code was sent to{" "}
            <strong>{state.challenge.channel}</strong>. Enter it to confirm; it expires soon and
            works once.
          </p>
          <input
            aria-label="Confirmation code"
            data-testid="confirm-code"
            className="w-full rounded border border-neutral-300 px-2 py-1 font-mono uppercase dark:border-neutral-600 dark:bg-neutral-800"
            autoComplete="one-time-code"
            inputMode="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={state.kind === "sending"}
          />
          {state.kind === "enter" && state.error && (
            <Banner tone="error" testId="confirm-error">
              {state.error}
            </Banner>
          )}
          <div className="flex justify-between gap-2">
            <Button type="button" onClick={onNewCode} disabled={state.kind === "sending"}>
              Send a new code
            </Button>
            <span className="flex gap-2">
              <Button type="button" onClick={onClose} disabled={state.kind === "sending"}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                data-testid="confirm-submit"
                disabled={state.kind === "sending" || !code.trim()}
              >
                Confirm
              </Button>
            </span>
          </div>
        </form>
      )}
    </Dialog>
  );
}
