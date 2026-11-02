import { useEffect } from "react";
import { Link } from "react-router";
import type { HumanRequestView, ProjectCard, ProjectPullRequestView } from "../../api/client.ts";
import { ExternalLink } from "../../components/ExternalLink.tsx";
import { FolderPath } from "../../components/FolderPath.tsx";
import { ReadAloud } from "../../components/ReadAloud.tsx";
import { buttonClassName, ErrorBanner, Loading } from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { elapsedWords, useNow } from "../../shell/ShellBars.tsx";
import { useClient, useUiState } from "../../store/context.tsx";
import { DecisionsSection } from "./DecisionsSection.tsx";
import { PeersSection } from "./PeersSection.tsx";
import { QueueSection } from "./QueueSection.tsx";

/**
 * Overview (design §3.4, was Summary): where this project stands and what happens next. Its
 * status sentence is the page header's; below it this project's Needs you cards, Working now,
 * Last result, Next (computed when shown), Your files, Decisions and one Note for the next
 * session. No stage, no queue form with types and priorities, no Peers in solo mode, no zero
 * counts.
 */
export function SummaryTab({ projectId, project }: { projectId: string; project?: ProjectCard }) {
  return (
    <div className="space-y-6" data-testid="summary-tab">
      <ProjectCards projectId={projectId} />
      {project?.working ? <WorkingNow project={project} /> : null}
      <SummaryCard projectId={projectId} project={project} />
      <DecisionsSection projectId={projectId} />
      <QueueSection projectId={projectId} />
      <PeersSection projectId={projectId} />
    </div>
  );
}

/** This project's open Inbox cards, one line each with Answer (design §3.4 "Needs you"). */
function ProjectCards({ projectId }: { projectId: string }) {
  const client = useClient();
  const humanId = useUiState((s) => s.me?.id ?? null);
  const count = useUiState((s) => s.blockingCount);
  const inbox = useAsync(
    (signal) => (humanId ? client.inbox(humanId, signal) : Promise.resolve(null)),
    [client, humanId],
  );
  const { reload } = inbox;
  useEffect(() => {
    if (count >= 0) reload();
  }, [count, reload]);
  const open: HumanRequestView[] = (inbox.data?.requests ?? []).filter(
    (r) => r.status === "open" && r.projectId === projectId,
  );
  if (open.length === 0) return null;
  return (
    <section data-testid="overview-needs-you" aria-labelledby="overview-needs-you-title">
      <h2 id="overview-needs-you-title" className="font-semibold">
        Needs you
      </h2>
      <ul className="mt-1 space-y-1">
        {open.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50/50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/30"
            data-testid="overview-card"
          >
            <span className="flex-1">{r.title ?? r.why}</span>
            <Link
              to={`/inbox#card-${encodeURIComponent(r.id)}`}
              className={buttonClassName("primary")}
            >
              Answer
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Design §3.4 "Working now": the task in flight, for how long, and Open. */
function WorkingNow({ project }: { project: ProjectCard }) {
  const now = useNow();
  const w = project.working;
  if (!w) return null;
  const elapsed = elapsedWords(w.since, now);
  return (
    <section data-testid="overview-working" aria-labelledby="overview-working-title">
      <h2 id="overview-working-title" className="font-semibold">
        Working now
      </h2>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <span>
          {w.agentName ?? "Your agent"} is working on{" "}
          {w.taskTitle ? `"${w.taskTitle}"` : "the next task"}
          {elapsed ? ` · ${elapsed}` : ""}
        </span>
        <Link
          to={`/sessions/${encodeURIComponent(w.sessionId)}`}
          className={buttonClassName("secondary")}
          data-testid="overview-working-open"
        >
          Open
        </Link>
      </p>
    </section>
  );
}

/** Last result, Next and Your files, read when shown (design §3.4). */
function SummaryCard({ projectId, project }: { projectId: string; project?: ProjectCard }) {
  const client = useClient();
  const summary = useAsync(
    (signal) => client.projectSummary(projectId, signal),
    [client, projectId],
  );
  // The project changed (a task finished, a session ended): read Last result and Next again.
  const version = project ? JSON.stringify([project.statusLine, project.progress]) : "";
  const { reload } = summary;
  useEffect(() => {
    if (version) reload();
  }, [version, reload]);

  if (summary.loading && !summary.data) return <Loading what="summary" />;
  if (summary.error && !summary.data)
    return <ErrorBanner message={summary.error} onRetry={summary.reload} />;
  const data = summary.data;
  if (!data) return null;
  const next = data.next ?? data.nextSteps;
  const changed = data.lastSession?.changedFiles ?? [];

  return (
    <div className="space-y-6" data-testid="summary">
      <section aria-labelledby="last-result-title">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="last-result-title" className="font-semibold">
            Last result
          </h2>
          {data.lastSession ? (
            <span className="ml-auto">
              <ReadAloud start={() => client.speakProject(projectId)} fallbackText={data.spoken} />
            </span>
          ) : null}
        </div>
        {data.lastSession ? (
          <div className="text-sm">
            <p className="whitespace-pre-line" data-testid="last-result">
              {data.lastSession.summary}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              {data.lastSession.endedAt ? `${relativeTime(data.lastSession.endedAt)} · ` : ""}
              <Link
                to={`/sessions/${encodeURIComponent(data.lastSession.id)}`}
                className="text-blue-700 hover:underline dark:text-blue-300"
              >
                Open the session
              </Link>
            </p>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">No session yet.</p>
        )}
      </section>
      {next.length > 0 ? (
        <section aria-labelledby="next-title">
          <h2 id="next-title" className="font-semibold">
            Next
          </h2>
          <ul className="text-sm" data-testid="next">
            {next.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {project?.repository ? (
        <RepositoryFiles
          projectId={projectId}
          repository={project.repository}
          version={version}
          changed={changed}
        />
      ) : project?.folder ? (
        <section aria-labelledby="files-title" data-testid="your-files">
          <h2 id="files-title" className="font-semibold">
            Your files
          </h2>
          <div className="mt-1 space-y-1 text-sm">
            <FolderPath path={project.folder} />
            {changed.length > 0 ? (
              <p data-testid="changed-files">
                Changed by the last session:{" "}
                {changed.slice(0, 8).map((f, i) => (
                  <span key={f}>
                    {i > 0 ? ", " : ""}
                    <Link
                      to={`/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(f)}`}
                      className="text-blue-700 hover:underline dark:text-blue-300"
                    >
                      {f}
                    </Link>
                  </span>
                ))}
                {changed.length > 8 ? ` and ${changed.length - 8} more` : ""}
              </p>
            ) : null}
            <Link
              to={`/projects/${encodeURIComponent(projectId)}/files`}
              className="text-blue-700 hover:underline dark:text-blue-300"
            >
              See every file
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * "Your files" of a project linked to a repository (design §3.4, §3.10; ADR 0104): the
 * repository with its page, and the pull requests that wait for the person to merge them, each
 * with its link, read from the git host when shown. Before (GitHub walk, 2026-11-02) the result
 * said "5 reviewed pull requests wait for you to merge" and no screen but the Tasks row's small
 * "PR" linked one; this page named a folder of this computer that held none of that work.
 */
function RepositoryFiles({
  projectId,
  repository,
  version,
  changed,
}: {
  projectId: string;
  repository: { fullName: string; url: string };
  version: string;
  changed: string[];
}) {
  const client = useClient();
  const prs = useAsync(
    (signal) => client.projectPullRequests(projectId, signal),
    [client, projectId],
  );
  const { reload } = prs;
  useEffect(() => {
    if (version) reload();
  }, [version, reload]);
  const waiting: ProjectPullRequestView[] = prs.data?.waiting ?? [];
  return (
    <section aria-labelledby="files-title" data-testid="your-files">
      <h2 id="files-title" className="font-semibold">
        Your files
      </h2>
      <div className="mt-1 space-y-2 text-sm">
        <p data-testid="repository">
          On GitHub:{" "}
          <ExternalLink href={repository.url} variant="inline" testId="repository-link">
            {repository.fullName}
          </ExternalLink>
        </p>
        {prs.error && !prs.data ? <ErrorBanner message={prs.error} onRetry={prs.reload} /> : null}
        {prs.data?.error ? (
          <p className="text-neutral-600 dark:text-neutral-400" data-testid="prs-error">
            {prs.data.error}
          </p>
        ) : null}
        {waiting.length > 0 ? (
          <div data-testid="prs-waiting">
            <h3 className="font-medium">Waiting for you to merge</h3>
            <p className="text-xs text-neutral-500">
              Reviewed by the critic. Merging on GitHub puts the work into the default branch.
            </p>
            <ul className="mt-1 space-y-0.5">
              {waiting.map((pr) => (
                <li key={pr.number} data-testid="pr-waiting" className="flex flex-wrap gap-2">
                  <span>
                    "{pr.title}" · pull request #{pr.number}
                  </span>
                  <ExternalLink href={pr.url} variant="inline" testId="pr-waiting-link">
                    Open
                  </ExternalLink>
                </li>
              ))}
            </ul>
          </div>
        ) : prs.data && !prs.data.error ? (
          <p className="text-neutral-600 dark:text-neutral-400" data-testid="prs-none">
            No pull request waits for you.
          </p>
        ) : null}
        {changed.length > 0 ? (
          <p data-testid="changed-files">
            Changed by the last session: {changed.slice(0, 8).join(", ")}
            {changed.length > 8 ? ` and ${changed.length - 8} more` : ""}
          </p>
        ) : null}
      </div>
    </section>
  );
}
