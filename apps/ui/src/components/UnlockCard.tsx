import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AUTO_UNLOCK_WINDOW_HOURS,
  type PreparedAnswer,
  prepareAnswer,
  type RunnerKeyBridge,
  type RunnerKeyStatus,
  shortDuration,
  type UnlockChallengeCard,
  type UnlockChoice,
  unlockChallengeOf,
  windowOpen,
} from "../lib/runner-unlock.ts";
import { formatDateTime } from "../lib/time.ts";
import { Button, ErrorBanner } from "./ui.tsx";

/**
 * The cloud runner unlock card (spec S.12, ADR 0068), shared by the desktop and phone inboxes:
 * which runner asks, for which project, when the challenge was filed, how old it is and when it
 * expires; Unlock once, Unlock and allow 1 h / 8 h / 24 h, Unlock and clear the window, Deny.
 * The card never sees the key: the bridge returns the wrapped answer and the parent sends it.
 * Without a key here (a browser, a device that does not hold it) the card is read-only and
 * says why.
 */
export interface UnlockRequestLike {
  id: string;
  kind: string;
  why: string;
  createdAt: string;
  projectId: string | null;
  projectName: string | null;
  changeCard?: unknown;
}

export interface UnlockCardProps {
  request: UnlockRequestLike;
  card: UnlockChallengeCard;
  bridge: RunnerKeyBridge;
  /** The auto-unlock window this device set, or null. */
  windowUntil: string | null;
  now: () => number;
  /** Send the prepared answer (and record the window); throws to show an error. */
  onSend: (prepared: PreparedAnswer) => Promise<void>;
  /** "" on the desktop, "m-" on the phone. */
  testIdPrefix?: string;
  /** Extra line under the buttons (the phone's biometric note). */
  note?: ReactNode;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useRunnerKeyStatus(bridge: RunnerKeyBridge, runnerId: string) {
  const [status, setStatus] = useState<RunnerKeyStatus | null>(null);
  useEffect(() => {
    let live = true;
    setStatus(null);
    bridge
      .status(runnerId)
      .then((s) => live && setStatus(s))
      .catch(
        (e) =>
          live &&
          setStatus({
            available: false,
            backend: bridge.kind,
            reason: `Could not reach the keyring: ${describe(e)}`,
          }),
      );
    return () => {
      live = false;
    };
  }, [bridge, runnerId]);
  return status;
}

/** Re-render every 30 s so the challenge's age and time left stay current. */
function useTick(ms = 30_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function UnlockCard({
  request,
  card,
  bridge,
  windowUntil,
  now,
  onSend,
  testIdPrefix = "",
  note,
}: UnlockCardProps) {
  const id = (name: string) => `${testIdPrefix}${name}`;
  const status = useRunnerKeyStatus(bridge, card.runnerId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useTick();
  const at = now();
  const age = at - Date.parse(request.createdAt);
  const left = Date.parse(card.expiresAt) - at;
  const expired = left <= 0;
  const open = windowOpen(windowUntil, at);

  const choose = async (choice: UnlockChoice) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(await prepareAnswer(bridge, card, choice, now()));
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-2 space-y-2 rounded border border-amber-300 p-2 text-sm dark:border-amber-800"
      data-testid={id("unlock-card")}
      data-runner-id={card.runnerId}
      aria-label="Cloud runner vault unlock"
    >
      <h3 className="font-medium">Cloud runner vault unlock</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-neutral-500">Runner</dt>
        <dd data-testid={id("unlock-runner")}>{card.runnerId}</dd>
        <dt className="text-neutral-500">Project</dt>
        <dd data-testid={id("unlock-project")}>
          {request.projectName ?? request.projectId ?? "No project (the runner as a whole)"}
        </dd>
        <dt className="text-neutral-500">Filed</dt>
        <dd data-testid={id("unlock-filed")}>{formatDateTime(request.createdAt)}</dd>
        <dt className="text-neutral-500">Challenge</dt>
        <dd data-testid={id("unlock-age")}>
          {shortDuration(age)} old ·{" "}
          {expired ? (
            <span className="text-red-700 dark:text-red-300">
              expired; the runner files a fresh one
            </span>
          ) : (
            `expires in ${shortDuration(left)}`
          )}
        </dd>
      </dl>
      {open && windowUntil ? (
        <p className="text-xs" data-testid={id("unlock-window")}>
          Auto-unlock window open until {formatDateTime(windowUntil)}.
        </p>
      ) : null}
      {status === null ? (
        <p className="text-xs text-neutral-500">Checking the keyring…</p>
      ) : !status.available ? (
        <p
          className="text-xs text-amber-800 dark:text-amber-300"
          data-testid={id("unlock-readonly")}
        >
          Read-only here: {status.reason}
        </p>
      ) : expired ? null : (
        <div className="flex flex-wrap gap-2" data-testid={id("unlock-actions")}>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void choose({ kind: "once" })}
            data-testid={id("unlock-once")}
          >
            Unlock once
          </Button>
          {AUTO_UNLOCK_WINDOW_HOURS.map((hours) => (
            <Button
              key={hours}
              disabled={busy}
              onClick={() => void choose({ kind: "window", hours })}
              data-testid={id(`unlock-window-${hours}`)}
            >
              Unlock and allow for {hours} h
            </Button>
          ))}
          <Button
            disabled={busy}
            onClick={() => void choose({ kind: "clear" })}
            data-testid={id("unlock-clear")}
          >
            Unlock and clear the window
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void choose({ kind: "deny" })}
            data-testid={id("unlock-deny")}
          >
            Deny
          </Button>
        </div>
      )}
      {note}
      {error ? <ErrorBanner message={error} testId={id("unlock-error")} /> : null}
    </section>
  );
}

/**
 * Auto-unlock (ADR 0068): while the window this device set is open, the next unlock challenge
 * is answered without a choice (once, leaving the window as it is) and a notice says so. Each
 * request is tried once; a failure leaves the card for the human.
 */
export function useAutoUnlock<R extends UnlockRequestLike>(opts: {
  requests: R[];
  bridge: RunnerKeyBridge;
  windowUntil: string | null;
  now: () => number;
  send: (request: R, prepared: PreparedAnswer) => Promise<void>;
  notify: (notice: string) => void;
}) {
  const tried = useRef(new Set<string>());
  const { requests, bridge, windowUntil, now, send, notify } = opts;
  useEffect(() => {
    for (const request of requests) {
      const card = unlockChallengeOf(request);
      if (!card || tried.current.has(request.id)) continue;
      const at = now();
      if (!windowOpen(windowUntil, at) || Date.parse(card.expiresAt) <= at) continue;
      tried.current.add(request.id);
      void (async () => {
        try {
          const status = await bridge.status(card.runnerId);
          if (!status.available) return;
          await send(request, await prepareAnswer(bridge, card, { kind: "once" }, now()));
          notify(
            `Unlocked cloud runner "${card.runnerId}" automatically: the auto-unlock window is open until ${formatDateTime(windowUntil)}.`,
          );
        } catch (e) {
          notify(
            `Could not unlock cloud runner "${card.runnerId}" automatically (${describe(e)}); answer on its card.`,
          );
        }
      })();
    }
  }, [requests, bridge, windowUntil, now, send, notify]);
}
