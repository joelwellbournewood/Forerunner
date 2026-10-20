import { Badge, ErrorBanner, Loading } from "../../components/ui.tsx";
import { formatDateTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

/** Decision log (spec J.4): answered decisions, never asked again unless superseded. */
export function DecisionsSection({ projectId }: { projectId: string }) {
  const client = useClient();
  const decisions = useAsync((signal) => client.decisions(projectId, signal), [client, projectId]);
  const rows = [...(decisions.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const superseded = new Set(rows.map((d) => d.supersedes).filter((s): s is string => s !== null));

  return (
    <section data-testid="decisions" aria-labelledby="decisions-title">
      <h2 id="decisions-title" className="font-semibold">
        Decisions
      </h2>
      <p className="text-xs text-neutral-500">
        Answered questions are recorded here and not asked again unless superseded.
      </p>
      {decisions.loading && !decisions.data ? <Loading what="decisions" /> : null}
      {decisions.error && !decisions.data ? (
        <ErrorBanner message={decisions.error} onRetry={decisions.reload} />
      ) : null}
      {decisions.data && rows.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-500" data-testid="decisions-empty">
          No decisions yet.
        </p>
      ) : null}
      <ul className="mt-1 space-y-2">
        {rows.map((d) => (
          <li
            key={d.id}
            className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
            data-testid="decision"
            data-decision-id={d.id}
            data-superseded={superseded.has(d.id) ? "true" : "false"}
          >
            <p className="font-medium">{d.question}</p>
            <p className="mt-1">
              <span className="font-semibold" data-testid="decision-chosen">
                {d.chosen}
              </span>
              {d.options.filter((o) => o !== d.chosen).length > 0 ? (
                <span className="text-xs text-neutral-500">
                  {" "}
                  (not: {d.options.filter((o) => o !== d.chosen).join(", ")})
                </span>
              ) : null}
            </p>
            {d.rationale ? (
              <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{d.rationale}</p>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span>by {d.decidedBy}</span>
              <span>{formatDateTime(d.createdAt)}</span>
              {d.supersedes ? <Badge tone="info">supersedes {d.supersedes}</Badge> : null}
              {superseded.has(d.id) ? <Badge tone="warn">superseded</Badge> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
