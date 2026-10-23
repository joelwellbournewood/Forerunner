import { useCallback, useEffect, useState } from "react";
import { describeStateError, type ReviewView } from "../../api/state-client.ts";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
} from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import { MobileController, useMobileController, useMobileState } from "../store.tsx";

/**
 * PR and critic review on the phone (spec R.5; ADR 0080): the project's critic reviews with
 * the PR they judged and the findings, newest first. The human comments (a message to the
 * agent responsible for the task), approves or rejects; a verdict also answers the task's open
 * approval request, and when that request is high risk the biometric prompt runs first and
 * its flag is signed into the request (ADR 0045, ADR 0009). Verdicts need a connection.
 */
function verdictTone(verdict: string): "good" | "warn" | "bad" | "neutral" {
  if (verdict === "accept" || verdict === "pass") return "good";
  if (verdict === "revise" || verdict === "needs_work") return "warn";
  if (verdict === "reject" || verdict === "fail") return "bad";
  return "neutral";
}

function severityTone(severity: string): "bad" | "warn" | "neutral" {
  if (severity === "critical" || severity === "blocker" || severity === "major") return "bad";
  if (severity === "minor" || severity === "medium") return "warn";
  return "neutral";
}

export function ReviewsScreen() {
  const controller = useMobileController();
  const projects = useMobileState((s) => s.projects);
  const activeProjectId = useMobileState((s) => s.activeProjectId);
  const stage = useMobileState((s) => s.stage);
  const [projectId, setProjectId] = useState<string>(activeProjectId ?? "");
  const [reviews, setReviews] = useState<ReviewView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && activeProjectId) setProjectId(activeProjectId);
  }, [activeProjectId, projectId]);

  const reload = useCallback(
    async (id: string) => {
      setError(null);
      try {
        setReviews(await controller.loadReviews(id));
      } catch (e) {
        setReviews([]);
        setError(describeStateError(e));
      }
    },
    [controller],
  );

  useEffect(() => {
    if (stage === "paired" && projectId) void reload(projectId);
  }, [stage, projectId, reload]);

  if (stage !== "paired") return null;

  return (
    <section aria-labelledby="m-reviews-title" className="space-y-3">
      <div className="flex items-center gap-2">
        <h1 id="m-reviews-title" className="text-xl font-semibold">
          Reviews
        </h1>
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={() => projectId && void reload(projectId)}
        >
          Refresh
        </Button>
      </div>
      <Field label="Project">
        <select
          className={INPUT_CLASS}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          data-testid="m-reviews-project"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      {error ? <ErrorBanner message={error} testId="m-reviews-error" /> : null}
      {reviews === null ? <Loading what="reviews" /> : null}
      {reviews && reviews.length === 0 ? (
        <EmptyState testId="m-no-reviews">No critic reviews for this project yet.</EmptyState>
      ) : null}
      <ol className="space-y-3" data-testid="m-review-list">
        {(reviews ?? []).map((r) => (
          <ReviewCard key={r.id} review={r} onDone={() => projectId && void reload(projectId)} />
        ))}
      </ol>
    </section>
  );
}

function ReviewCard({ review, onDone }: { review: ReviewView; onDone: () => void }) {
  const controller = useMobileController();
  // Re-read on inbox changes: the approval request a verdict answers lives there.
  useMobileState((s) => s.inbox);
  const request = controller.reviewRequest(review);
  const high = request ? MobileController.isHighRisk(request) : false;
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const run = async (what: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setOutcome(await what());
    } catch (e) {
      setError(describeStateError(e));
    } finally {
      setBusy(false);
    }
  };

  const sendComment = () =>
    run(async () => {
      await controller.commentReview(review, comment.trim());
      setComment("");
      return "Comment sent to the agent.";
    });

  const verdict = (v: "approve" | "reject") =>
    run(async () => {
      const r = await controller.reviewVerdict(review, v, comment);
      setComment("");
      onDone();
      return `${v === "approve" ? "Approved" : "Rejected"}${
        r.answeredRequestId ? "; the waiting session continues." : "."
      }`;
    });

  return (
    <li
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="m-review"
      data-review-id={review.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{review.taskTitle ?? review.id}</span>
        <Badge tone={verdictTone(review.verdict)}>{review.verdict}</Badge>
        <Badge>grade {review.grade}</Badge>
        <Badge>tier {review.tier}</Badge>
        <span className="ml-auto text-xs text-neutral-500">{relativeTime(review.createdAt)}</span>
      </div>
      {review.prUrl ? (
        <a
          href={review.prUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block truncate text-sm text-blue-700 underline dark:text-blue-300"
          data-testid="m-review-pr"
        >
          {review.prUrl}
        </a>
      ) : (
        <p className="mt-1 text-xs text-neutral-500">No pull request linked.</p>
      )}
      <p className="mt-2 text-sm">{review.summary}</p>
      {review.findings.length > 0 ? (
        <ul className="mt-2 space-y-1" data-testid="m-findings">
          {review.findings.map((f) => (
            <li
              key={f.id}
              className="rounded bg-neutral-50 p-2 text-sm dark:bg-neutral-900"
              data-testid="m-finding"
              data-severity={f.severity}
            >
              <div className="flex items-center gap-2">
                <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                <Badge>{f.status}</Badge>
              </div>
              <p className="mt-1">{f.description}</p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                Needed: {f.requiredAction}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-neutral-500">The critic recorded no findings.</p>
      )}
      {request ? (
        <p className="mt-2 text-xs" data-testid="m-review-waiting">
          <Badge tone="warn">waiting on you</Badge> {request.why}
        </p>
      ) : null}
      {high ? (
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300" data-testid="m-review-high">
          High risk: approving or rejecting asks for your fingerprint or face first.
        </p>
      ) : null}
      <textarea
        className={`${INPUT_CLASS} mt-2`}
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Comment (sent with a verdict too)…"
        aria-label="Comment"
        data-testid="m-review-comment"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          onClick={() => void sendComment()}
          disabled={busy || !comment.trim()}
          data-testid="m-review-send-comment"
        >
          Comment
        </Button>
        <Button
          variant="primary"
          onClick={() => void verdict("approve")}
          disabled={busy}
          data-testid="m-review-approve"
        >
          Approve
        </Button>
        <Button
          variant="danger"
          onClick={() => void verdict("reject")}
          disabled={busy}
          data-testid="m-review-reject"
        >
          Reject
        </Button>
      </div>
      {outcome ? (
        <output
          className="mt-2 block text-xs text-emerald-800 dark:text-emerald-300"
          data-testid="m-review-outcome"
        >
          {outcome}
        </output>
      ) : null}
      {error ? (
        <div className="mt-2">
          <ErrorBanner message={error} testId="m-review-error" />
        </div>
      ) : null}
    </li>
  );
}
