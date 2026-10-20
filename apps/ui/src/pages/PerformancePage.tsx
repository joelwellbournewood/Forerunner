import { useState } from "react";
import type { PerformanceModeView } from "../api/contracts.ts";
import { TargetBar } from "../components/charts.tsx";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Badge, ErrorBanner, INPUT_CLASS, Loading } from "../components/ui.tsx";
import { formatMs, formatShare } from "../lib/format.ts";
import { formatDateTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState } from "../store/context.tsx";

/** The measured figure a mode's target applies to: first token (or audio) or the whole run. */
export function measuredAgainstTarget(mode: PerformanceModeView): number | null {
  switch (mode.targetKind) {
    case "first_token":
    case "first_audio":
      return mode.ttftP95Ms;
    case "total":
      return mode.totalP95Ms;
    default:
      return null;
  }
}

export function targetLabel(mode: PerformanceModeView): string {
  switch (mode.targetKind) {
    case "first_token":
      return `first token under ${formatMs(mode.targetMs)}`;
    case "first_audio":
      return `first audio under ${formatMs(mode.targetMs)}`;
    case "total":
      return `under ${formatMs(mode.targetMs)}`;
    default:
      return "set by task budget and timeout";
  }
}

/** Performance view (spec D.7, D.19): time to first token and total time per mode against target. */
export function PerformancePage() {
  const client = useClient();
  const projects = useUiState((s) => s.projects);
  const [projectId, setProjectId] = useState<string>("");
  const perf = useAsync(
    (signal) => client.performance({ projectId: projectId || undefined }, signal),
    [client, projectId],
  );
  const estimates = useAsync((signal) => client.costEstimates(signal), [client]);

  return (
    <section aria-labelledby="performance-title" className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 id="performance-title" className="text-xl font-semibold">
          Performance
        </h1>
        <select
          className={`${INPUT_CLASS} ml-auto w-auto`}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Project"
          data-testid="performance-project"
        >
          <option value="">all projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-neutral-500">
        Every run records time to first token and total time; each mode has a response-time target.
        The bar is the 95th percentile against the target.
      </p>
      {perf.routeMissing ? (
        <RouteMissing route="performance" what="response times per mode" />
      ) : null}
      {perf.loading && !perf.data ? <Loading what="performance" /> : null}
      {perf.error && !perf.routeMissing && !perf.data ? (
        <ErrorBanner message={perf.error} onRetry={perf.reload} />
      ) : null}
      {perf.data ? (
        <>
          <span className="text-xs text-neutral-500">
            as of {formatDateTime(perf.data.generatedAt)}
          </span>
          <table className="w-full text-sm" data-testid="performance-modes">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th className="py-1 pr-2">Mode</th>
                <th className="py-1 pr-2">Target</th>
                <th className="py-1 pr-2">Samples</th>
                <th className="py-1 pr-2">First token p50 / p95</th>
                <th className="py-1 pr-2">Total p50 / p95</th>
                <th className="py-1 pr-2">Within target</th>
                <th className="py-1">p95 vs target</th>
              </tr>
            </thead>
            <tbody>
              {perf.data.modes.map((m) => (
                <tr
                  key={m.mode}
                  className="border-t border-neutral-100 dark:border-neutral-800"
                  data-testid="performance-mode"
                  data-mode={m.mode}
                >
                  <td className="py-1 pr-2 font-medium">{m.label}</td>
                  <td className="py-1 pr-2 text-xs text-neutral-600 dark:text-neutral-400">
                    {targetLabel(m)}
                  </td>
                  <td className="py-1 pr-2">{m.samples}</td>
                  <td className="py-1 pr-2 font-mono text-xs" data-testid="ttft">
                    {formatMs(m.ttftP50Ms)} / {formatMs(m.ttftP95Ms)}
                  </td>
                  <td className="py-1 pr-2 font-mono text-xs" data-testid="total">
                    {formatMs(m.totalP50Ms)} / {formatMs(m.totalP95Ms)}
                  </td>
                  <td className="py-1 pr-2">
                    {m.withinTargetShare === null ? (
                      <span className="text-xs text-neutral-500">—</span>
                    ) : (
                      <Badge
                        tone={
                          m.withinTargetShare >= 0.9
                            ? "good"
                            : m.withinTargetShare >= 0.7
                              ? "warn"
                              : "bad"
                        }
                      >
                        {formatShare(m.withinTargetShare)}
                      </Badge>
                    )}
                  </td>
                  <td className="py-1">
                    <TargetBar
                      value={measuredAgainstTarget(m)}
                      target={m.targetMs > 0 ? m.targetMs : null}
                      format={formatMs}
                      testId="target-bar"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="text-xs">
            <summary className="cursor-pointer text-neutral-500">
              {perf.data.recent.length} recent run{perf.data.recent.length === 1 ? "" : "s"}
            </summary>
            <table className="mt-1 w-full" data-testid="performance-recent">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="py-0.5 pr-2">Run</th>
                  <th className="py-0.5 pr-2">Mode</th>
                  <th className="py-0.5 pr-2">Specialist</th>
                  <th className="py-0.5 pr-2">Model</th>
                  <th className="py-0.5 pr-2">First token</th>
                  <th className="py-0.5 pr-2">Total</th>
                  <th className="py-0.5">At</th>
                </tr>
              </thead>
              <tbody>
                {perf.data.recent.map((r) => (
                  <tr key={r.runId} className="border-t border-neutral-100 dark:border-neutral-800">
                    <td className="py-0.5 pr-2 font-mono">{r.runId}</td>
                    <td className="py-0.5 pr-2">{r.mode}</td>
                    <td className="py-0.5 pr-2">{r.specialist}</td>
                    <td className="py-0.5 pr-2">{r.model}</td>
                    <td className="py-0.5 pr-2">{formatMs(r.ttftMs)}</td>
                    <td className="py-0.5 pr-2">{formatMs(r.durationMs)}</td>
                    <td className="py-0.5">{formatDateTime(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : null}

      <div data-testid="estimates">
        <h2 className="font-semibold">Estimate accuracy</h2>
        <p className="text-xs text-neutral-500">
          Estimate before every run, actual after; the error is tracked per specialist and task
          kind.
        </p>
        {estimates.loading && !estimates.data ? <Loading what="estimate accuracy" /> : null}
        {estimates.error && !estimates.data ? (
          <ErrorBanner message={estimates.error} onRetry={estimates.reload} />
        ) : null}
        {estimates.data ? (
          <>
            <dl
              className="mt-2 grid grid-cols-2 gap-3 text-sm md:grid-cols-4"
              data-testid="estimates-overall"
            >
              <div>
                <dt className="text-xs text-neutral-500">Samples</dt>
                <dd className="text-lg font-semibold">{estimates.data.overall.samples}</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">Mean abs. error</dt>
                <dd className="text-lg font-semibold">
                  {estimates.data.overall.mean_abs_error_pct.toFixed(1)}%
                </dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">Bias</dt>
                <dd className="text-lg font-semibold">
                  {estimates.data.overall.bias_pct > 0 ? "+" : ""}
                  {estimates.data.overall.bias_pct.toFixed(1)}%
                </dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">Within 25%</dt>
                <dd className="text-lg font-semibold">
                  {formatShare(estimates.data.overall.within_25_pct_share)}
                </dd>
              </div>
            </dl>
            {estimates.data.rows.length > 0 ? (
              <table className="mt-2 w-full text-sm" data-testid="estimates-rows">
                <thead className="text-left text-xs text-neutral-500">
                  <tr>
                    <th className="py-1 pr-2">Specialist</th>
                    <th className="py-1 pr-2">Kind</th>
                    <th className="py-1 pr-2">Samples</th>
                    <th className="py-1 pr-2" title="actual / estimate">
                      Cost ratio
                    </th>
                    <th className="py-1 pr-2" title="actual / estimate">
                      Time ratio
                    </th>
                    <th className="py-1 pr-2">Mean abs. error</th>
                    <th className="py-1">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {estimates.data.rows.map((r) => (
                    <tr
                      key={`${r.specialist}/${r.kind}`}
                      className="border-t border-neutral-100 dark:border-neutral-800"
                    >
                      <td className="py-1 pr-2">{r.specialist}</td>
                      <td className="py-1 pr-2">{r.kind}</td>
                      <td className="py-1 pr-2">{r.samples}</td>
                      <td className="py-1 pr-2">{r.cost_ratio.toFixed(2)}×</td>
                      <td className="py-1 pr-2">{r.wall_ratio.toFixed(2)}×</td>
                      <td className="py-1 pr-2">{r.mean_abs_error_pct.toFixed(1)}%</td>
                      <td className="py-1">{formatShare(r.confidence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-1 text-sm text-neutral-500">
                No completed runs with an estimate yet.
              </p>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
