import { useState } from "react";
import type { CommandResultJson } from "../api/client.ts";
import { type ChangeCardView, parseChangeCard } from "../api/contracts.ts";
import { inAppText, withoutUndoWord } from "../lib/plain-words.ts";
import { Badge, Button, ErrorBanner } from "./ui.tsx";

/** The change card of spec Q.4, as a block: what, old → new, scope, duration, impact, undo. */
export function ChangeCard({
  card,
  testId = "change-card",
}: {
  card: ChangeCardView;
  testId?: string;
}) {
  const riskTone =
    card.impact.risk === "high" ? "bad" : card.impact.risk === "medium" ? "warn" : "good";
  return (
    <div
      className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-700"
      data-testid={testId}
      data-risk={card.impact.risk}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{card.what}</span>
        <Badge tone={riskTone}>{card.impact.risk} risk</Badge>
        {card.scopeLabel ? <Badge>{card.scopeLabel}</Badge> : null}
        <Badge>{card.duration}</Badge>
        {!card.reversible ? <Badge tone="bad">no undo</Badge> : null}
      </div>
      <p className="mt-2">
        <span className="font-mono text-xs line-through opacity-70" data-testid="card-old">
          {card.oldValue || "—"}
        </span>{" "}
        →{" "}
        <span className="font-mono text-xs font-semibold" data-testid="card-new">
          {card.newValue}
        </span>
      </p>
      {card.usesActiveProject && card.projectName ? (
        <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          Applies to {card.projectName}, the active project.
        </p>
      ) : null}
      {card.impact.costChfMicro !== undefined ? (
        <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          Cost impact: CHF {(card.impact.costChfMicro / 1_000_000).toFixed(2)}
        </p>
      ) : null}
      {card.undoHint ? (
        <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400" data-testid="card-undo">
          {inAppText(card.undoHint)}
        </p>
      ) : null}
      {card.parts && card.parts.length > 0 ? (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
          {card.parts.map((p) => (
            <li key={`${p.command}-${p.what}`}>
              {p.what}: {p.oldValue || "—"} → {p.newValue}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * What a command returned, as the screen shows it: a pending confirmation with Yes/No, a
 * done change with its sentence and Undo, a cancellation or a refusal. The same component
 * serves the settings screen and any other button that runs a command (spec Q: every route
 * shows the same card and writes the same change log entry).
 */
export function CommandResult({
  result,
  busy,
  onConfirm,
  onUndo,
  onDismiss,
}: {
  result: CommandResultJson;
  busy?: boolean;
  onConfirm: (answer: "yes" | "no") => void;
  onUndo?: (changeLogId: string) => void;
  onDismiss: () => void;
}) {
  const [undone, setUndone] = useState(false);
  const card = parseChangeCard(result.card);
  if (result.status === "pending") {
    return (
      <div
        className="space-y-2"
        data-testid="command-pending"
        data-decision={result.decision ?? ""}
      >
        {card ? <ChangeCard card={card} /> : null}
        <p className="text-sm" data-testid="command-readback">
          {inAppText(result.readback ?? "")}
        </p>
        {result.decision === "needs_device" ? (
          <p className="text-xs text-neutral-600 dark:text-neutral-400" data-testid="needs-device">
            High risk: confirmation in the app on a paired device. This desktop counts as one; a
            chat or email "yes" alone would not.
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => onConfirm("yes")}
            disabled={busy}
            data-testid="command-yes"
          >
            {result.decision === "needs_device" ? "Confirm on this device" : "Yes"}
          </Button>
          <Button onClick={() => onConfirm("no")} disabled={busy} data-testid="command-no">
            No
          </Button>
        </div>
      </div>
    );
  }
  if (result.status === "done" || result.status === "partial") {
    return (
      <div className="space-y-2" data-testid="command-done">
        {card ? <ChangeCard card={card} /> : null}
        <output className="block text-sm" data-testid="command-sentence">
          {withoutUndoWord(result.sentence ?? "").text}
          {result.status === "partial" && result.reason ? ` (${result.reason})` : ""}
        </output>
        <div className="flex gap-2">
          {result.undoToken && result.changeLogId && onUndo && !undone ? (
            <Button
              onClick={() => {
                setUndone(true);
                onUndo(result.changeLogId ?? "");
              }}
              disabled={busy}
              data-testid="command-undo"
            >
              Undo
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onDismiss} data-testid="command-close">
            Close
          </Button>
        </div>
      </div>
    );
  }
  if (result.status === "cancelled") {
    return (
      <div className="space-y-2" data-testid="command-cancelled">
        <p className="text-sm">Cancelled. Nothing changed.</p>
        <Button variant="ghost" onClick={onDismiss} data-testid="command-close">
          Close
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="command-refused">
      {card ? <ChangeCard card={card} /> : null}
      <ErrorBanner message={`Refused (${result.code ?? "refused"}): ${result.reason ?? ""}`} />
      <Button variant="ghost" onClick={onDismiss} data-testid="command-close">
        Close
      </Button>
    </div>
  );
}
