import type { CostView } from "../../api/client.ts";
import { Badge, ErrorBanner, Loading, Money } from "../../components/ui.tsx";
import { formatDayMonth } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

type Bucket = CostView["byModel"][number];

/** The period the figures cover, in words (design §5): "1 Nov to 3 Nov", "on 1 Nov". */
export function periodWords(from: string, to: string): string {
  if (!from && !to) return "Nothing spent yet";
  const a = formatDayMonth(from || to);
  const b = formatDayMonth(to || from);
  return a === b ? `On ${a}` : `${a} to ${b}`;
}

/** Cost per accepted task (spec I.6); null when nothing was accepted or acceptance is not tracked. */
export function costPerAccepted(bucket: Bucket): Bucket["cost"] | null {
  if (bucket.accepted === null || bucket.accepted <= 0) return null;
  return {
    usdMicro: Math.round(bucket.cost.usdMicro / bucket.accepted),
    chfMicro: Math.round(bucket.cost.chfMicro / bucket.accepted),
  };
}

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
              <th className="py-1 pr-2" title="Accepted by the critic / runs">
                Accepted
              </th>
              <th className="py-1 pr-2 text-right">Per accepted</th>
              <th className="py-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const per = costPerAccepted(r);
              return (
                <tr key={r.key} className="border-t border-neutral-100 dark:border-neutral-800">
                  <td className="py-1 pr-2">{r.label}</td>
                  <td className="py-1 pr-2">{r.runs}</td>
                  <td className="py-1 pr-2">
                    {r.accepted === null
                      ? "—"
                      : `${r.accepted} / ${r.runs} (${Math.round((r.accepted / Math.max(1, r.runs)) * 100)}%)`}
                  </td>
                  <td className="py-1 pr-2 text-right" data-testid="cost-per-accepted">
                    {per ? <Money value={per} /> : "—"}
                  </td>
                  <td className="py-1 text-right">
                    <Money value={r.cost} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** One line of "Savings (not spend)": what saved it, what that is worth and how many tokens. */
export interface SavingsLineView {
  kind: "compression" | "cache";
  label: string;
  money: CostView["savings"]["cache"];
  tokens: number;
}

/**
 * The lines of "Savings (not spend)" (ADR 0003, ADR 0008), with no zero counts (design §5 rule
 * 5, L3-run-13): a line that saved nothing is left out (live check 3 read "Context compression /
 * CHF 0.00 · 0 tokens" on a project whose only spend was planning), and no line means no box.
 */
export function savingsLines(savings: CostView["savings"]): SavingsLineView[] {
  const lines: SavingsLineView[] = [
    {
      kind: "compression",
      label: "Context compression",
      money: savings.compression,
      tokens: savings.compressionTokens,
    },
    { kind: "cache", label: "Prompt cache", money: savings.cache, tokens: savings.cacheTokens },
  ];
  return lines.filter((l) => l.tokens > 0 || l.money.chfMicro > 0);
}

/**
 * "CHF 2.30 · 1,200,000 tokens"; tokens that no price covers (a model without a price row) read
 * as the tokens alone, never "CHF 0.00" beside them.
 */
function SavingsLine({ line }: { line: SavingsLineView }) {
  const worth = line.money.chfMicro > 0;
  const tokens = line.tokens > 0 ? `${line.tokens.toLocaleString()} tokens` : "";
  return (
    <>
      <dt className="text-neutral-500">{line.label}</dt>
      <dd data-testid={`cost-savings-${line.kind}`}>
        {worth ? <Money value={line.money} /> : null}
        {worth && tokens ? " · " : ""}
        {tokens}
      </dd>
    </>
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
  const savings = savingsLines(data.savings);

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
        <span className="text-xs text-neutral-500" data-testid="cost-period">
          {periodWords(data.from, data.to)}
        </span>
      </div>
      {/* OJ-07 (d1109-onerepo-join): what each project joined into this one spent before. */}
      {(data.joinedSpend ?? []).map((j) => (
        <p key={j.projectId} className="text-sm" data-testid="cost-joined">
          {j.words}
        </p>
      ))}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <BucketTable title="By model" rows={data.byModel} testId="cost-by-model" />
        <BucketTable title="By specialist" rows={data.bySpecialist} testId="cost-by-specialist" />
        <BucketTable title="By task" rows={data.byTask} testId="cost-by-task" />
        {savings.length > 0 ? (
          <div
            data-testid="cost-savings"
            className="rounded border border-emerald-200 p-3 dark:border-emerald-900"
          >
            <h3 className="text-sm font-semibold">Savings (not spend)</h3>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              {savings.map((line) => (
                <SavingsLine key={line.kind} line={line} />
              ))}
            </dl>
          </div>
        ) : null}
      </div>
    </div>
  );
}
