import type { CostView } from "../../api/client.ts";
import { Badge, ErrorBanner, Loading, Money } from "../../components/ui.tsx";
import { formatDateTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

type Bucket = CostView["byModel"][number];

function BucketTable({ title, rows, testId }: { title: string; rows: Bucket[]; testId: string }) {
  return (
    <div data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-neutral-500">Nothing yet.</p>
      ) : (
        <table className="mt-1 w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th className="py-1 pr-2">Name</th>
              <th className="py-1 pr-2">Runs</th>
              <th className="py-1 pr-2">Accepted</th>
              <th className="py-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="py-1 pr-2">{r.label}</td>
                <td className="py-1 pr-2">{r.runs}</td>
                <td className="py-1 pr-2">
                  {r.accepted === null ? "—" : `${r.accepted} / ${r.runs}`}
                </td>
                <td className="py-1 text-right">
                  <Money value={r.cost} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Costs tab: totals, by model, by specialist, by task; savings shown separately (ADR 0008). */
export function CostsTab({ projectId }: { projectId: string }) {
  const client = useClient();
  const costs = useAsync((signal) => client.costs({ projectId }, signal), [client, projectId]);

  if (costs.loading && !costs.data) return <Loading what="costs" />;
  if (costs.error && !costs.data)
    return <ErrorBanner message={costs.error} onRetry={costs.reload} />;
  const data = costs.data;
  if (!data) return null;

  return (
    <div className="space-y-4" data-testid="costs">
      <div className="flex flex-wrap items-baseline gap-3">
        <div>
          <div className="text-xs text-neutral-500">Total spend</div>
          <div className="text-2xl font-semibold" data-testid="cost-total">
            <Money value={data.totals} />
          </div>
        </div>
        {data.planUsageShare !== null ? (
          <Badge
            tone="info"
            title="Subscription usage is a share of the plan; the CHF figure is the estimated API-equivalent"
          >
            plan usage {Math.round(data.planUsageShare * 100)}% (est. API-equivalent shown)
          </Badge>
        ) : null}
        <span className="text-xs text-neutral-500">
          {formatDateTime(data.from)} → {formatDateTime(data.to)}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <BucketTable title="By model" rows={data.byModel} testId="cost-by-model" />
        <BucketTable title="By specialist" rows={data.bySpecialist} testId="cost-by-specialist" />
        <BucketTable title="By task" rows={data.byTask} testId="cost-by-task" />
        <div
          data-testid="cost-savings"
          className="rounded border border-emerald-200 p-3 dark:border-emerald-900"
        >
          <h3 className="text-sm font-semibold">Savings (not spend)</h3>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-neutral-500">Context compression</dt>
            <dd>
              <Money value={data.savings.compression} /> ·{" "}
              {data.savings.compressionTokens.toLocaleString()} tokens
            </dd>
            <dt className="text-neutral-500">Prompt cache</dt>
            <dd>
              <Money value={data.savings.cache} /> · {data.savings.cacheTokens.toLocaleString()}{" "}
              tokens
            </dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
