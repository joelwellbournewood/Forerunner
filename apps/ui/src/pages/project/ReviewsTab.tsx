import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ReviewsView } from "../../api/client.ts";
import { TrendLine, type TrendPoint } from "../../components/charts.tsx";
import { RouteMissing } from "../../components/RouteMissing.tsx";
import { Badge, ErrorBanner, INPUT_CLASS, Loading, type Tone } from "../../components/ui.tsx";
import { reviewLevel, verdictLabel } from "../../lib/plain-words.ts";
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

/** A finding's state as a person reads it; a closed task's findings are no open work. */
export function findingStateWords(status: string, taskStatus: string | null): string {
  if (status === "open" && (taskStatus === "done" || taskStatus === "cancelled"))
    return taskStatus === "done" ? "closed: the task is done" : "closed: the task was cancelled";
  switch (status) {
    case "open":
      return "to fix";
    case "resolved":
      return "fixed";
    case "wontfix":
      return "accepted as it is";
    case "pattern":
      return "seen before";
    default:
      return status;
  }
}

/** The daemon's grade trend (oldest first) as chart points (spec H.3, K.2). */
export function trendPoints(trend: ReviewsView["gradeTrend"]): TrendPoint[] {
  return trend.map((p) => ({ label: formatDate(p.at), value: p.grade }));
}

function evidenceText(e: unknown): string {
  return typeof e === "string" ? e : JSON.stringify(e);
}

type Review = ReviewsView["reviews"][number];

/** One review: the verdict and its grade in the verdict's colour, the findings, Details. */
function ReviewItem({
  r,
  projectId,
  highlighted,
}: {
  r: Review;
  projectId: string;
  highlighted: boolean;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "center" });
  }, [highlighted]);
  return (
    <li
      ref={ref}
      className={`rounded border p-3 text-sm ${
        highlighted
          ? "border-blue-500 ring-2 ring-blue-400 dark:border-blue-400"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
      data-testid="review"
      data-review-id={r.id}
      data-verdict={r.verdict}
      data-highlighted={highlighted ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* The grade takes the verdict's colour: a sent-back review is never green. */}
        <Badge tone={verdictTone(r.verdict)} testId="review-grade">
          {r.grade} / 100
        </Badge>
        <Badge tone={verdictTone(r.verdict)} testId="review-verdict">
          {verdictLabel(r.verdict)}
        </Badge>
        <span className="ml-auto text-xs text-neutral-500">{formatDateTime(r.createdAt)}</span>
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
          "Session check"
        )}
      </p>
      <p className="mt-1">{r.summary}</p>
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
                <Badge
                  tone={
                    f.status === "open" && r.taskStatus !== "done" && r.taskStatus !== "cancelled"
                      ? "warn"
                      : "neutral"
                  }
                  testId="finding-state"
                >
                  {findingStateWords(f.status, r.taskStatus)}
                </Badge>
              </div>
              <p className="mt-1">{f.description}</p>
              {f.requiredAction ? (
                <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                  To fix: {f.requiredAction}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {/* What the critic checked and how: under Details (design §5 rule 1). */}
      <details className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
        <summary className="cursor-pointer" data-testid="review-details-toggle">
          Details
        </summary>
        <div className="mt-1 space-y-1" data-testid="review-details">
          <p>
            {reviewLevel(r.tier)}; confidence {Math.round(r.confidence * 100)}%; {r.criticModel}
          </p>
          {r.sessionId ? (
            <p>
              <Link
                to={`/sessions/${encodeURIComponent(r.sessionId)}`}
                className="text-blue-700 hover:underline dark:text-blue-300"
              >
                Session log
              </Link>
            </p>
          ) : null}
          {r.evidence.length > 0 ? (
            <ul className="list-disc pl-5" data-testid="review-evidence">
              {r.evidence.map((e) => (
                <li key={evidenceText(e)}>{evidenceText(e)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/**
 * Reviews tab (design §3.5, §5): the critic's verdict on each task in words, its grade in the
 * verdict's colour, the findings still to fix counted once per task, and the review a link
 * named (`?review=<id>`, the task drawer's) scrolled to and highlighted. The critic's evidence
 * is under Details; the session self-checks are folded away, not counted as open work.
 */
export function ReviewsTab({ projectId }: { projectId: string }) {
  const client = useClient();
  const [params] = useSearchParams();
  const wanted = params.get("review");
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
  const taskReviews = data.reviews.filter((r) => r.taskId !== null);
  const sessionChecks = data.reviews.filter((r) => r.taskId === null);
  const rows = taskReviews.filter((r) => verdict === "all" || r.verdict === verdict);
  const verdictNames = Object.keys(data.verdicts).sort();
  const wantedSession = sessionChecks.some((r) => r.id === wanted);

  return (
    <div className="space-y-4" data-testid="reviews">
      <div className="flex flex-wrap items-center gap-3">
        <Badge testId="reviews-count">
          {taskReviews.length} review{taskReviews.length === 1 ? "" : "s"}
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
            {verdictLabel(v)} {data.verdicts[v]}
          </span>
        ))}
        <label className="ml-auto flex items-center gap-1 text-sm">
          Result
          <select
            aria-label="Filter by result"
            data-testid="filter-verdict"
            value={verdict}
            onChange={(e) => setVerdict(e.target.value)}
            className={`${INPUT_CLASS} w-auto`}
          >
            <option value="all">all</option>
            {verdictNames.map((v) => (
              <option key={v} value={v}>
                {verdictLabel(v)}
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
          No reviews yet. The critic reviews each task when its work is finished.
        </p>
      ) : null}
      <ul className="space-y-2">
        {rows.map((r) => (
          <ReviewItem key={r.id} r={r} projectId={projectId} highlighted={r.id === wanted} />
        ))}
      </ul>
      {sessionChecks.length > 0 ? (
        <details
          className="text-sm"
          data-testid="session-checks"
          open={wantedSession ? true : undefined}
        >
          <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">
            Session checks ({sessionChecks.length}): the critic's check of each session's summary
            and spend
          </summary>
          <ul className="mt-2 space-y-2">
            {sessionChecks.map((r) => (
              <ReviewItem key={r.id} r={r} projectId={projectId} highlighted={r.id === wanted} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
