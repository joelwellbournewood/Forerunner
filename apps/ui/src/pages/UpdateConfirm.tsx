import { Dialog } from "../components/Dialog.tsx";
import { Button } from "../components/ui.tsx";

/**
 * Ask first (U-076). "Update and restart" and "Roll back and restart" restart the background
 * service, which ends the sessions it runs; while any run, the screen says how many and asks.
 * "Run evaluations" spends money; the screen says up to how much before it runs them.
 */
export type PendingConfirm =
  | { kind: "apply" | "rollback"; running: number; run: () => void }
  | { kind: "evaluate"; evals: number; upTo: string | null; run: () => void };

export function sessionsWord(n: number): string {
  return `${n} session${n === 1 ? " is" : "s are"} running`;
}

/** What the dialog says for a pending action. */
export function confirmText(p: PendingConfirm): { title: string; body: string; yes: string } {
  if (p.kind === "evaluate") {
    const cost = p.upTo ? `up to ${p.upTo} (an estimate: the most these runs may spend)` : "money";
    return {
      title: "Run the evaluations?",
      body: `${p.evals} evaluation run${p.evals === 1 ? "" : "s"} will cost ${cost}, counted against your caps. Nothing else changes until you adopt a recommendation.`,
      yes: "Run evaluations",
    };
  }
  const them = p.running === 1 ? "it" : "them";
  const what = p.kind === "apply" ? "Updating" : "Rolling back";
  return {
    title: p.kind === "apply" ? "Update and restart now?" : "Roll back and restart now?",
    body: `${sessionsWord(p.running)}. ${what} restarts Forerunner's background service, which stops ${them}; start ${them} again afterwards.`,
    yes: p.kind === "apply" ? "Update and restart" : "Roll back and restart",
  };
}

export function ConfirmDialog({
  pending,
  onClose,
}: {
  pending: PendingConfirm | null;
  onClose: () => void;
}) {
  const text = pending ? confirmText(pending) : null;
  return (
    <Dialog
      open={pending !== null}
      onClose={onClose}
      title={text?.title ?? ""}
      testId="updates-confirm"
    >
      <p className="text-sm" data-testid="updates-confirm-text">
        {text?.body}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose} data-testid="updates-confirm-no">
          Not now
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            const run = pending?.run;
            onClose();
            run?.();
          }}
          data-testid="updates-confirm-yes"
        >
          {text?.yes}
        </Button>
      </div>
    </Dialog>
  );
}
