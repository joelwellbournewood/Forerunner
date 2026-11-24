import { useState } from "react";
import { describeError } from "../../api/client.ts";
import { Button } from "../../components/ui.tsx";
import { refreshProjects, useClient, useUiStore } from "../../store/context.tsx";

/**
 * L4e-left-1 (l4-github-carried; the default of owner question OQ-L4e-1): Try again beside the
 * take-over's line that says its docs pull request could not be opened, on the Overview and on
 * Docs (design §5 rule 8: what went wrong and what to do). The press runs the scaffold again
 * (`POST /projects/:id/take-over/retry`); once a docs pull request names this project the
 * project's card is read again, the line goes, and `onOpened` gets the answer's sentence for
 * the page to show. A refusal says why beside the button, which stays. `line` is the daemon's
 * consequence line (`repositoryElsewhere.tryAgainLine`): no line, no button.
 */
export function TakeOverTryAgain({
  projectId,
  line,
  testId,
  onOpened,
}: {
  projectId: string;
  line: string | null | undefined;
  testId: string;
  onOpened: (sentence: string) => void;
}) {
  const client = useClient();
  const store = useUiStore();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  if (!line) return null;
  const press = async () => {
    setBusy(true);
    setRefused(null);
    try {
      const r = await client.retryTakeOver(projectId);
      if (r.state === "opened") {
        onOpened(r.sentence);
        await refreshProjects(client, store).catch(() => undefined);
      } else setRefused(r.sentence);
    } catch (e) {
      setRefused(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid={testId}>
      <Button
        variant="secondary"
        className="px-2 py-0.5 text-xs"
        disabled={busy}
        title={line}
        onClick={() => void press()}
        data-testid={`${testId}-button`}
      >
        {busy ? "Trying again…" : "Try again"}
      </Button>
      <span
        className="text-xs text-neutral-600 dark:text-neutral-400"
        data-testid={`${testId}-line`}
      >
        {line}
      </span>
      {refused ? (
        <span
          className="basis-full text-xs text-red-700 dark:text-red-300"
          data-testid={`${testId}-refused`}
          role="alert"
        >
          {refused}
        </span>
      ) : null}
    </span>
  );
}
