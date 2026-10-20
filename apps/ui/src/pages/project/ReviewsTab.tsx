import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { ReviewsView } from "../../api/client.ts";
import { TrendLine, type TrendPoint } from "../../components/charts.tsx";
import { RouteMissing } from "../../components/RouteMissing.tsx";
import { Badge, ErrorBanner, INPUT_CLASS, Loading, type Tone } from "../../components/ui.tsx";
import { formatDate, formatDateTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

export function gradeTone(grade: number): Tone {
  if (grade >= 70) return "good";
  if (grade >= 50) return "warn";
  return "bad";
}

export function verdictTone(verdict: string): Tone {
  switch (verdict) {
    case "accept":
      return "good";
    case "revise":
      return "warn";
    case "escalate":
    case "human":
      return "bad";
    default:
      return "neutral";
  }
}

function severityTone(severity: string): Tone {
  switch (severity) {
    case "critical":
    case "high":
      return "bad";
    case "medium":
      return "warn";
    case "low":
      return "info";
    default:
      return "neutral";
  }
}

/** The daemon's grade trend (oldest first) as chart points (spec H.3, K.2). */
export function trendPoints(trend: ReviewsView["gradeTrend"]): TrendPoint[] {
  return trend.map((p) => ({ label: formatDate(p.at), value: p.grade }));
}

function evidenceText(e: unknown): string {
  return typeof e === "string" ? e : JSON.stringify(e);
}

/** Reviews tab: the critic's verdicts, findings and the grade trend. */
export function ReviewsTab({ projectId }: { projectId: string }) {
  const client = useClient();
  const reviews = useAsync(
    (signal) => client.reviews(projectId, { limit: 200 }, signal),
    [client, projectId],
  );
  const [verdict, setVerdict] = useState<string>("all");
  const points = useMemo(() => trendPoints(reviews.data?.gradeTrend ?? []), [reviews.data]);

  if (reviews.routeMissing) return <RouteMissing route="reviews" what="the critic's reviews" />;
  if (reviews.loading && !reviews.data) return <Loading what="reviews" />;
  if (reviews.error && !reviews.data)
    return <ErrorBanner message={reviews.error} onRetry={reviews.reload} />;
  const data = reviews.data;
  if (!data) return null;
  const rows = data.reviews.filter((r) => verdict === "all" || r.verdict === verdict);
  const verdictNames = Object.keys(data.verdicts).sort();

  return (
    <div className="space-y-4" data-testid="reviews">
      <div className="flex flex-wrap items-center gap-3">
        <Badge testId="reviews-count">
          {data.reviews.length} review{data.reviews.length === 1 ? "" : "s"}
        </Badge>
        <Badge tone={data.openFindings > 0 ? "warn" : "neutral"} testId="open-findings">
          {data.openFindings} open finding{data.openFindings === 1 ? "" : "s"}
        </Badge>
        {data.averageGrade !== null ? (
          <Badge tone={gradeTone(data.averageGrade)} testId="average-grade">
            average {data.averageGrade}
          </Badge>
        ) : null}
        {verdictNames.map((v) => (
          <span key={v} className="text-xs text-neutral-500" data-testid="verdict-count">
            {v} {data.verdicts[v]}
          </span>
        ))}
        <label className="ml-auto flex items-center gap-1 text-sm">
          Verdict
          <select
            aria-label="Filter by verdict"
            data-testid="filter-verdict"
            value={verdict}
            onChange={(e) => setVerdict(e.target.value)}
            className={`${INPUT_CLASS} w-auto`}
          >
            <option value="all">all</option>
            {verdictNames.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>

      <TrendLine
        points={points}
        title="Grade trend (0 to 100, oldest to newest)"
        target={{ value: 70, label: "accept line 70" }}
        testId="grade-trend"
      />

      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="reviews-empty">
          No reviews yet. The critic reviews every task at tier 1 and above.
        </p>
      ) : null}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.id}
            className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
            data-testid="review"
            data-review-id={r.id}
            data-verdict={r.verdict}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={gradeTone(r.grade)} testId="review-grade">
                {r.grade} / 100
              </Badge>
              <Badge tone={verdictTone(r.verdict)} testId="review-verdict">
                {r.verdict}
              </Badge>
              <Badge>tier {r.tier}</Badge>
              <Badge title="The critic's confidence; low confidence never becomes accept">
                confidence {Math.round(r.confidence * 100)}%
              </Badge>
              <span className="text-xs text-neutral-500">{r.criticModel}</span>
              <span className="ml-auto text-xs text-neutral-500">
                {formatDateTime(r.createdAt)}
              </span>
            </div>
            <p className="mt-2 font-medium">
              {r.taskTitle ? (
                <Link
                  to={`/projects/${encodeURIComponent(projectId)}/tasks`}
                  className="text-blue-700 hover:underline dark:text-blue-300"
                >
                  {r.taskTitle}
                </Link>
              ) : (
                "Session review"
              )}
            </p>
            <p className="mt-1">{r.summary}</p>
            {r.sessionId ? (
              <p className="mt-1 text-xs">
                <Link
                  to={`/sessions/${encodeURIComponent(r.sessionId)}`}
                  className="text-blue-700 hover:underline dark:text-blue-300"
                >
                  session log
                </Link>
              </p>
            ) : null}
            {r.evidence.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-400">
                {r.evidence.map((e) => (
                  <li key={evidenceText(e)}>{evidenceText(e)}</li>
                ))}
              </ul>
            ) : null}
            {r.findings.length > 0 ? (
              <ul className="mt-2 space-y-1" data-testid="findings">
                {r.findings.map((f) => (
                  <li
                    key={f.id}
                    className="rounded bg-neutral-50 p-2 dark:bg-neutral-900"
                    data-testid="finding"
                    data-severity={f.severity}
                    data-status={f.status}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                      <Badge tone={f.status === "open" ? "warn" : "neutral"}>{f.status}</Badge>
                      {f.status === "pattern" ? (
                        <Badge tone="info" title="Seen across sessions; turned into a lesson">
                          pattern
                        </Badge>
                      ) : null}
                      {f.resolvedByRun ? (
                        <span className="text-xs text-neutral-500">
                          resolved by run {f.resolvedByRun}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1">{f.description}</p>
                    {f.requiredAction ? (
                      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                        Required: {f.requiredAction}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
