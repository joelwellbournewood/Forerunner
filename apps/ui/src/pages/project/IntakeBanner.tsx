import { useEffect, useState } from "react";
import { Link } from "react-router";
import { describeError, type IntakeStatusView } from "../../api/client.ts";
import { Button } from "../../components/ui.tsx";
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
        Drafting the plan from your brief. It lands in your Inbox for approval when it is ready.
      </output>
    );
  if (view.state === "pending")
    return (
      <div
        className={`${box} border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100`}
        data-testid="intake-banner"
        data-state="pending"
      >
        The plan from your brief waits for your approval in the{" "}
        <Link to="/inbox" className="underline">
          Inbox
        </Link>
        .
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
        <p className="font-medium">The plan from your brief could not be drafted.</p>
        {view.error ? (
          <p className="mt-1 whitespace-pre-wrap" data-testid="intake-error">
            {view.error}
          </p>
        ) : null}
        <p className="mt-1">Nothing was written. Retry drafts it again from the same brief.</p>
        {error ? (
          <p className="mt-1" data-testid="intake-retry-error">
            {error}
          </p>
        ) : null}
        <Button
          className="mt-2"
          variant="primary"
          onClick={() => void retry()}
          disabled={busy}
          data-testid="intake-retry"
        >
          {busy ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  return null;
}
