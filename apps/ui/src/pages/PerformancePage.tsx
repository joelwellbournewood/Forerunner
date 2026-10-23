import { useState } from "react";
import {
  type AuditExportFormat,
  describeError,
  isRouteMissing,
  type PerformanceModeView,
} from "../api/client.ts";
import { TargetBar } from "../components/charts.tsx";
import { Badge, Button, ErrorBanner, INPUT_CLASS, Loading } from "../components/ui.tsx";
import { saveTextFile } from "../lib/download.ts";
import { formatMs, formatShare } from "../lib/format.ts";
import { formatDateTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState } from "../store/context.tsx";

/** The measured figure a mode's target applies to: first token (or audio) or the whole run. */
export function measuredAgainstTarget(mode: PerformanceModeView): number | null {
  switch (mode.targetKind) {
    case "first_token":
    case "first_audio":
      return mode.ttftP90Ms;
    case "total":
      return mode.totalP90Ms;
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

/**
 * The effort in force for a mode (spec D.7: the lowest effort that passes the task's checks):
 * the effort table's, and the project's speed-versus-quality offset where the code applies it.
 */
export function effortLabel(mode: PerformanceModeView): string {
  const effort =
    mode.effort === mode.baseEffort ? mode.effort : `${mode.effort} (table ${mode.baseEffort})`;
  // A risky task runs the mode higher (the coder at risk tier 2+, a tier 3 critic review).
  return mode.riskEffort && mode.riskTierFrom !== null
    ? `${effort}; ${mode.riskEffort} from risk tier ${mode.riskTierFrom}`
    : effort;
}

/** The windows the page offers; the daemon accepts 1 to 90 days. */
export const PERFORMANCE_WINDOWS = [1, 7, 30, 90] as const;

/** Performance view (spec D.7, D.19): time to first token and total time per mode against target. */
export function PerformancePage() {
  const client = useClient();
  const projects = useUiState((s) => s.projects);
  const [projectId, setProjectId] = useState<string>("");
  const [days, setDays] = useState<number>(7);
  const perf = useAsync(
    (signal) => client.performance({ projectId: projectId || undefined, days }, signal),
    [client, projectId, days],
  );
  const estimates = useAsync((signal) => client.costEstimates(signal), [client]);

  // Audit log export (spec S.9): the daemon streams the file; the browser saves it.
  const [exportFormat, setExportFormat] = useState<AuditExportFormat>("jsonl");
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<{ tone: "good" | "bad"; text: string } | null>(
    null,
  );
  async function exportAudit() {
    setExporting(true);
    setExportStatus(null);
    try {
      const file = await client.auditExport({ format: exportFormat });
      const rows = `${file.rows} row${file.rows === 1 ? "" : "s"}`;
      if (saveTextFile(file)) {
        setExportStatus({ tone: "good", text: `Exported ${rows} to ${file.filename}` });
      } else {
        setExportStatus({
          tone: "bad",
          text: `Fetched ${rows}, but this browser cannot save files; run fr audit export instead`,
        });
      }
    } catch (err) {
      setExportStatus({
        tone: "bad",
        text: isRouteMissing(err)
          ? "This daemon has no audit export (GET /audit/export); update it or run fr audit export"
          : describeError(err),
      });
    } finally {
      setExporting(false);
    }
  }

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
        <select
          className={`${INPUT_CLASS} w-auto`}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Window"
          data-testid="performance-days"
        >
          {PERFORMANCE_WINDOWS.map((d) => (
            <option key={d} value={d}>
              last {d} day{d === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-neutral-500">
        Every run and chat turn records time to first token and total time; each mode has a
        response-time target. Figures are the median and the 90th percentile by nearest rank; the
        bar is the 90th percentile against the target. Effort is the one in force: the lowest that
        passes the task&apos;s checks, shifted by the project&apos;s speed-versus-quality setting
        where it applies.
      </p>
      {perf.loading && !perf.data ? <Loading what="performance" /> : null}
      {perf.error && !perf.data ? <ErrorBanner message={perf.error} onRetry={perf.reload} /> : null}
      {perf.data ? (
        <>
          <span className="text-xs text-neutral-500" data-testid="performance-window">
            last {perf.data.days} day{perf.data.days === 1 ? "" : "s"}, from{" "}
            {formatDateTime(perf.data.from)} to {formatDateTime(perf.data.generatedAt)}
            {perf.data.effortOffset !== 0
              ? `, speed-versus-quality offset ${perf.data.effortOffset > 0 ? "+" : ""}${perf.data.effortOffset}`
              : ""}
          </span>
          <table className="w-full text-sm" data-testid="performance-modes">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th className="py-1 pr-2">Mode</th>
                <th className="py-1 pr-2">Target</th>
                <th className="py-1 pr-2">Effort</th>
                <th className="py-1 pr-2">Samples</th>
                <th className="py-1 pr-2">First token p50 / p90</th>
                <th className="py-1 pr-2">Total p50 / p90</th>
                <th className="py-1 pr-2">Within target</th>
                <th className="py-1 pr-2">p90 vs target</th>
                <th className="py-1">Last</th>
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
                  <td
                    className="py-1 pr-2 text-xs"
                    data-testid="effort"
                    title={`${m.tier}, ${
                      m.offsetApplied
                        ? "the project's speed-versus-quality offset applies"
                        : "the speed-versus-quality offset does not reach this mode yet"
                    }${m.maxEffort ? `, held at ${m.maxEffort} (the registry's max_effort)` : ""}`}
                  >
                    {effortLabel(m)}
                  </td>
                  <td className="py-1 pr-2">{m.samples}</td>
                  <td className="py-1 pr-2 font-mono text-xs" data-testid="ttft">
                    {formatMs(m.ttftP50Ms)} / {formatMs(m.ttftP90Ms)}
                  </td>
                  <td className="py-1 pr-2 font-mono text-xs" data-testid="total">
                    {formatMs(m.totalP50Ms)} / {formatMs(m.totalP90Ms)}
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
                  <td className="py-1 pr-2">
                    <TargetBar
                      value={measuredAgainstTarget(m)}
                      target={m.targetMs > 0 ? m.targetMs : null}
                      format={formatMs}
                      testId="target-bar"
                    />
                  </td>
                  <td className="py-1 text-xs text-neutral-500" data-testid="last">
                    {m.lastAt ? formatDateTime(m.lastAt) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="text-xs">
            <summary className="cursor-pointer text-neutral-500">
              {perf.data.recent.length} recent measurement
              {perf.data.recent.length === 1 ? "" : "s"}
            </summary>
            <table className="mt-1 w-full" data-testid="performance-recent">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="py-0.5 pr-2">Run</th>
                  <th className="py-0.5 pr-2">Source</th>
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
                    <td className="py-0.5 pr-2">{r.source}</td>
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

      <div data-testid="audit-export" className="space-y-2">
        <h2 className="font-semibold">Audit log</h2>
        <p className="text-xs text-neutral-500">
          Every tool call with who, what, when, cost and result, as the daemon recorded it: inputs
          and results are summarised and redacted when written, so the file holds no raw parameters.
          The export covers you and your agents.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-neutral-500" htmlFor="audit-export-format">
            Export format
          </label>
          <select
            id="audit-export-format"
            className={`${INPUT_CLASS} w-auto`}
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value === "csv" ? "csv" : "jsonl")}
            data-testid="audit-export-format"
          >
            <option value="jsonl">JSON lines</option>
            <option value="csv">CSV</option>
          </select>
          <Button
            variant="primary"
            onClick={() => void exportAudit()}
            disabled={exporting}
            data-testid="audit-export-button"
          >
            Export audit log
          </Button>
        </div>
        {exportStatus ? (
          <p
            role="status"
            data-testid="audit-export-status"
            className={
              exportStatus.tone === "good"
                ? "text-xs text-green-700 dark:text-green-400"
                : "text-xs text-red-700 dark:text-red-400"
            }
          >
            {exportStatus.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
