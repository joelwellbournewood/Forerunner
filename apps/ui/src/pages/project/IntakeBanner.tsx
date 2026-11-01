import { useEffect, useState } from "react";
import { Link } from "react-router";
import { describeError, type IntakeStatusView } from "../../api/client.ts";
import { Button, buttonClassName } from "../../components/ui.tsx";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

/** How often the page looks again while the plan is being drafted. */
export const INTAKE_POLL_MS = 3000;

/**
 * The project's plan from its brief, as the project page and the Start dialog read it
 * (U-046): `GET /projects/:id/intake`, read again every `pollMs` while it is being drafted, so
 * "drafting" turns into "waits in the Inbox" or "failed" without a reload. Null until the
 * first answer, and when the daemon cannot say.
 */
export function useIntakeStatus(
  projectId: string,
  opts: { enabled?: boolean; pollMs?: number } = {},
) {
  const client = useClient();
  const enabled = opts.enabled ?? true;
  const pollMs = opts.pollMs ?? INTAKE_POLL_MS;
  const status = useAsync<IntakeStatusView | null>(
    (signal) => (enabled ? client.intakeStatus(projectId, signal) : Promise.resolve(null)),
    [client, projectId, enabled],
  );
  const { reload, data } = status;
  // Every answer (a new object, even when it says "drafting" again) arms the next read.
  useEffect(() => {
    if (data?.state !== "drafting") return;
    const t = setTimeout(reload, pollMs);
    return () => clearTimeout(t);
  }, [data, reload, pollMs]);
  return status;
}

/**
 * The plan from the project's brief, above the tabs (U-046): being drafted, waiting in the
 * Inbox, or failed with what went wrong and a Retry (`POST /projects/:id/intake/retry`).
 * Before, a failed intake was invisible: no card, no error, no retry. Nothing is shown when
 * no plan was asked for, or once it was answered.
 */
export function IntakeBanner({ projectId, pollMs }: { projectId: string; pollMs?: number }) {
  const client = useClient();
  const status = useIntakeStatus(projectId, pollMs === undefined ? {} : { pollMs });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = status.data;
  if (!view) return null;

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.retryIntake(projectId);
      status.setData(() => next);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const box = "mb-3 rounded border p-2 text-sm";
  if (view.state === "drafting")
    return (
      <output
        className={`${box} block border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200`}
        data-testid="intake-banner"
        data-state="drafting"
      >
        Drafting the plan from your brief… It lands in your Inbox for you to approve.
      </output>
    );
  if (view.state === "pending")
    return (
      <div
        className={`${box} flex flex-wrap items-center gap-2 border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100`}
        data-testid="intake-banner"
        data-state="pending"
      >
        Waiting for you: approve the plan.
        <Link to="/inbox" className={buttonClassName("primary")} data-testid="intake-open">
          Open
        </Link>
      </div>
    );
  // Design §3.3: a rejected plan says so, and a new one can be drafted from the brief.
  const retryButton = (label: string, busyLabel: string) => (
    <Button
      className="mt-2"
      variant="primary"
      onClick={() => void retry()}
      disabled={busy}
      data-testid="intake-retry"
    >
      {busy ? busyLabel : label}
    </Button>
  );
  if (view.state === "rejected")
    return (
      <div
        className={`${box} border-neutral-300 bg-neutral-50 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100`}
        data-testid="intake-banner"
        data-state="rejected"
      >
        <p>You rejected the plan. Nothing was written.</p>
        <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          Draft a new plan: the agent drafts one again from your brief for you to approve.
        </p>
        {error ? (
          <p className="mt-1" data-testid="intake-retry-error">
            {error}
          </p>
        ) : null}
        {retryButton("Draft a new plan", "Drafting…")}
      </div>
    );
  if (view.state === "failed")
    return (
      <div
        role="alert"
        className={`${box} border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100`}
        data-testid="intake-banner"
        data-state="failed"
      >
        <p className="font-medium">Planning failed. Nothing was written.</p>
        {view.error ? (
          <p className="mt-1 whitespace-pre-wrap" data-testid="intake-error">
            {view.error}
          </p>
        ) : null}
        {error ? (
          <p className="mt-1" data-testid="intake-retry-error">
            {error}
          </p>
        ) : null}
        {retryButton("Try again", "Trying again…")}
      </div>
    );
  return null;
}
