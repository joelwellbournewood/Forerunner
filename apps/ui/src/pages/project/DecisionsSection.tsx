import { useState } from "react";
import { Link } from "react-router";
import type { DecisionView } from "../../api/client.ts";
import { ErrorBanner, Loading } from "../../components/ui.tsx";
import { formatDayMonth } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

/** How many decisions the Overview shows before "all" (design §3.4). */
export const DECISIONS_SHOWN = 5;

/**
 * A question as short as its answer allows, without a model call (later #79): "Where should the
 * page be published: GitHub Pages, Netlify, or only as a local file?" answered "Only as a local
 * file for now" reads "Where should the page be published?", since the answer names one of the
 * options listed after the colon. Kept whole when the answer names none of them.
 */
export function shortQuestion(question: string, answer: string): string {
  const q = question.trim();
  const m = /^(.+?):\s*(.+?)\?$/.exec(q);
  if (!m?.[1] || !m[2]) return q;
  const said = answer.toLowerCase();
  const options = m[2]
    .split(/,\s*|\s+or\s+/i)
    .map((o) =>
      o
        .replace(/^(or|and)\s+/i, "")
        .trim()
        .toLowerCase(),
    )
    .filter((o) => o.length >= 3);
  return options.some((o) => said.includes(o)) ? `${m[1].trim()}?` : q;
}

/** "Q? A." with the question's own end mark, or a colon where it has none. */
function sentence(d: DecisionView): string {
  const q = shortQuestion(d.question, d.chosen);
  const a = d.chosen.trim();
  const joined = /[?.!:]$/.test(q) ? `${q} ${a}` : `${q}: ${a}`;
  return /[.!?]$/.test(joined) ? joined : `${joined}.`;
}

/**
 * The project's decisions (spec J.4; design §3.4, §5 "Decision"): plain question and answer
 * pairs, "Q? A. (Robin, 1 Nov)", newest first, at most five with "all" for the rest, the plan
 * the person approved, and the decision records in the project's folder, which open in Docs.
 */
export function DecisionsSection({ projectId }: { projectId: string }) {
  const client = useClient();
  const decisions = useAsync((signal) => client.decisions(projectId, signal), [client, projectId]);
  const [all, setAll] = useState(false);
  const rows = [...(decisions.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const answers = rows.filter((d) => d.kind !== "record");
  const records = rows.filter((d) => d.kind === "record");
  const shown = all ? answers : answers.slice(0, DECISIONS_SHOWN);

  return (
    <section data-testid="decisions" aria-labelledby="decisions-title">
      <h2 id="decisions-title" className="font-semibold">
        Decisions
      </h2>
      {decisions.loading && !decisions.data ? <Loading what="decisions" /> : null}
      {decisions.error && !decisions.data ? (
        <ErrorBanner message={decisions.error} onRetry={decisions.reload} />
      ) : null}
      {decisions.data && rows.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-500" data-testid="decisions-empty">
          No decisions yet.
        </p>
      ) : null}
      <ul className="mt-1 space-y-1">
        {shown.map((d) => (
          <li
            key={d.id}
            className="text-sm"
            data-testid="decision"
            data-decision-id={d.id}
            data-kind={d.kind}
          >
            <span data-testid="decision-text">{sentence(d)}</span>{" "}
            <span className="text-neutral-500" data-testid="decision-by">
              ({d.decidedByName ?? "you"}, {formatDayMonth(d.createdAt)})
            </span>
          </li>
        ))}
      </ul>
      {answers.length > DECISIONS_SHOWN ? (
        <button
          type="button"
          className="mt-1 text-xs text-blue-700 hover:underline dark:text-blue-300"
          onClick={() => setAll((v) => !v)}
          data-testid="decisions-all"
        >
          {all ? "Show fewer" : `All ${answers.length} decisions`}
        </button>
      ) : null}
      {records.length > 0 ? (
        <p className="mt-2 text-sm" data-testid="decision-records">
          {records.length === 1 ? "Decision record: " : "Decision records: "}
          {records.map((r, i) => (
            <span key={r.id}>
              {i > 0 ? ", " : ""}
              <Link
                to={`/projects/${encodeURIComponent(projectId)}/docs`}
                className="text-blue-700 hover:underline dark:text-blue-300"
                title={r.path ?? undefined}
                data-testid="decision-record"
              >
                {r.question}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}
