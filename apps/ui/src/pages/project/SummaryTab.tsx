import { researchReadsLine, webAccessOf } from "@forerunner/runtime/wiring/web-access";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type {
  HumanRequestView,
  ProjectCard,
  ProjectPullRequestsView,
  ProjectPullRequestView,
  SettingView,
} from "../../api/client.ts";
import { ExternalLink } from "../../components/ExternalLink.tsx";
import { FolderPath } from "../../components/FolderPath.tsx";
import { ReadAloud } from "../../components/ReadAloud.tsx";
import { Button, buttonClassName, ErrorBanner, Loading } from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { elapsedWords, useNow } from "../../shell/ShellBars.tsx";
import { useClient, useUiState } from "../../store/context.tsx";
import { commandForSetting, SettingChangeDialog } from "../SettingsPage.tsx";
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
      <ResearchReads projectId={projectId} project={project} />
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
            {data.lastSession.since?.length ? (
              // What became of what the session left for you (C-54): the summary is the record
              // of its end, these lines are true now.
              <ul className="mt-1" data-testid="last-result-since">
                {data.lastSession.since.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : null}
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
          card={project}
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

/** The Settings row this project's research rule is changed on ('sites'). */
const WEB_ACCESS_ROW = "project.web_access";

/**
 * 'sites' (the owner's decision of 2026-11-02): one line on the Overview saying what research
 * may read on the web, "Research reads: any public website · Change". Change opens the same
 * dialog as the Settings row (Per project, "Web pages research may read"), with the same change
 * card; the line is the daemon's (`ProjectCard.researchReads`) and, after a change, the same
 * words from the row's new value.
 */
function ResearchReads({ projectId, project }: { projectId: string; project?: ProjectCard }) {
  const client = useClient();
  const [changed, setChanged] = useState<string | null>(null);
  const [row, setRow] = useState<SettingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const line = changed ?? project?.researchReads ?? null;
  if (!line) return null;
  const rowOf = async () =>
    (await client.settings({ scope: "project", scopeId: projectId })).find(
      (s) => s.key === WEB_ACCESS_ROW && s.scopeId === projectId,
    ) ?? null;
  const command = row ? commandForSetting(row) : null;
  return (
    <section className="text-sm" data-testid="research-reads">
      <span data-testid="research-reads-line">{line}</span>
      {" · "}
      <button
        type="button"
        className="text-blue-700 hover:underline dark:text-blue-300"
        onClick={() => {
          setError(null);
          void rowOf()
            .then((r) => (r ? setRow(r) : setError("This project's setting was not found.")))
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        }}
        data-testid="research-reads-change"
      >
        Change
      </button>
      {error ? <ErrorBanner message={error} /> : null}
      {row && command ? (
        <SettingChangeDialog
          setting={row}
          command={command}
          onClose={() => setRow(null)}
          onChanged={() => {
            void rowOf().then((r) => {
              if (r) setChanged(researchReadsLine(webAccessOf({ web_access: r.value as never })));
            });
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Who checked a waiting pull request, in the order the groups are listed: a group says it once
 * over its PRs, and no PR is listed under a check it did not get. Review (2026-11-02): every PR
 * read "Reviewed by the critic.", Forerunner's status and plan-docs PRs too.
 */
type PrGroup = "critic" | "you" | "not-reviewed" | "docs";
const PR_GROUPS: { key: PrGroup; label: string }[] = [
  { key: "critic", label: "Reviewed by the critic" },
  { key: "you", label: "Accepted by you at sign-off" },
  { key: "not-reviewed", label: "Marked done without the critic's review" },
  { key: "docs", label: "Forerunner's docs, merge them when you like" },
];

function groupOf(pr: ProjectPullRequestView): PrGroup {
  if (pr.kind === "docs") return "docs";
  if (pr.review === "critic") return "critic";
  if (pr.review === "you") return "you";
  return "not-reviewed";
}

/**
 * "Your files" of a project linked to a repository (design §3.4, §3.10; ADR 0106): the
 * repository with its page, and the pull requests that wait for the person to merge them, each
 * with its link, read from the git host when shown, grouped by who checked them (`PR_GROUPS`).
 * Before (GitHub walk, 2026-11-02) the result said "5 reviewed pull requests wait for you to
 * merge" and no screen but the Tasks row's small "PR" linked one; this page named a folder of
 * this computer that held none of that work.
 *
 * merge-in-app (the owner's decision of 2026-11-02): each row has **Merge**, which merges it in
 * the app (the pull requests it builds on first, each with a merge commit, through the safe
 * merge step), or the sentence that says why not; one line says who merges the project's
 * accepted work, with Change. The click is answered at once; the list is then read again every
 * `pollMs` until the rows it merges are gone (merged) or carry a sentence. Before, merging was
 * only on GitHub: "Merging on GitHub puts the work into the default branch."
 */
function RepositoryFiles({
  projectId,
  repository,
  version,
  card,
  changed,
  pollMs = MERGE_POLL_MS,
}: {
  projectId: string;
  repository: { fullName: string; url: string };
  version: string;
  /** The project's card as the store has it now: a new one each time the daemon says it changed. */
  card: ProjectCard;
  changed: string[];
  pollMs?: number;
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
  // The Merge pressed last: what the daemon answered, the pull requests it merges, and the list
  // as it was read before the answer (until a read after it comes, the click's sentence stands).
  const [pressed, setPressed] = useState<{
    order: number[];
    sentence: string;
    before: ProjectPullRequestsView | null;
  } | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting: ProjectPullRequestView[] = prs.data?.waiting ?? [];
  const inFlight = (pr: ProjectPullRequestView) =>
    pr.merge?.state === "merging" || pr.merge?.state === "queued";
  // A row that changes without the person (it waits for checks, its own or those of one it merges
  // after, or merges now): each time the daemon says the project changed (a merge the watcher's
  // retry made is one), the list is read again. The status sentence and progress do not move on a
  // merge, so `version` alone missed it (bench, 2026-11-08: the rows stayed until a reload).
  const settling = useRef(false);
  settling.current = waiting.some((pr) => inFlight(pr) || pr.merge?.state === "waiting_checks");
  useEffect(() => {
    if (card && settling.current) reload();
  }, [card, reload]);
  // Follow a Merge while one of its pull requests is still listed as merging (a row that waits
  // for checks, its own or those of one it merges after, is not: the project event of the merge
  // that frees it reads the list again).
  const following =
    pressed !== null &&
    (prs.data === pressed.before ||
      pressed.order.some((n) => {
        const row = waiting.find((w) => w.number === n);
        return row ? inFlight(row) : false;
      }));
  useEffect(() => {
    if (!following) return;
    const t = setInterval(() => reload(), pollMs);
    return () => clearInterval(t);
  }, [following, reload, pollMs]);
  // What the Merge pressed last came to, once nothing of it is in flight (review, 2026-11-08: the
  // line kept the click's "Merging #12 and #13 in order." above rows that said neither could
  // merge). Unknown while the list cannot be read: the line goes and the error says why.
  const listed = prs.data !== null && prs.data !== undefined && !prs.data.error;
  const outcome = pressed && listed && !following ? pressedOutcome(pressed.order, waiting) : null;
  const press = async (pr: ProjectPullRequestView) => {
    setBusy(true);
    setMergeError(null);
    try {
      const answer = await client.mergePullRequest(projectId, pr.number);
      if (answer.state === "refused") {
        setPressed(null);
        setMergeError(answer.sentence);
      } else setPressed({ order: answer.order, sentence: answer.sentence, before: prs.data });
      reload();
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const mode = prs.data?.mode;
  const kind = prs.data?.errorKind;
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
        {mode ? (
          <p data-testid="merge-mode">
            Merging:{" "}
            {mode.key === "after_review" ? "automatically after review" : "you press Merge"} ·{" "}
            <Link
              to="/settings#other-settings"
              className="text-blue-700 hover:underline dark:text-blue-300"
              data-testid="merge-mode-change"
            >
              Change
            </Link>
          </p>
        ) : null}
        {prs.error && !prs.data ? <ErrorBanner message={prs.error} onRetry={prs.reload} /> : null}
        {prs.data?.error ? (
          <p
            className="flex flex-wrap items-center gap-2 text-neutral-600 dark:text-neutral-400"
            data-testid="prs-error"
          >
            <span>{prs.data.error}</span>
            {kind === "no_token" || kind === "refused" ? (
              <Link to="/setup" className={buttonClassName("secondary")} data-testid="prs-connect">
                Connect GitHub
              </Link>
            ) : null}
          </p>
        ) : null}
        {pressed && (following || outcome) ? (
          <p data-testid="merge-answer" role="status">
            {outcome ?? pressed.sentence}
          </p>
        ) : null}
        {mergeError ? (
          <p className="text-red-700 dark:text-red-300" data-testid="merge-error" role="alert">
            {mergeError}
          </p>
        ) : null}
        {waiting.length > 0 ? (
          <div data-testid="prs-waiting">
            <h3 className="font-medium">Waiting for you to merge</h3>
            <p className="text-xs text-neutral-500">
              Merge puts the work into main with a merge commit; one that builds on others merges
              them first.
            </p>
            {PR_GROUPS.map((group) => {
              const prsOf = waiting.filter((pr) => groupOf(pr) === group.key);
              if (!prsOf.length) return null;
              return (
                <div key={group.key} data-testid={`prs-${group.key}`} className="mt-1">
                  <p className="text-xs text-neutral-600 dark:text-neutral-400">{group.label}</p>
                  <ul className="space-y-0.5">
                    {prsOf.map((pr) => (
                      <li
                        key={pr.number}
                        data-testid="pr-waiting"
                        data-number={pr.number}
                        data-merge-state={pr.merge?.state ?? "ready"}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <span>
                          "{pr.title}" · pull request #{pr.number}
                        </span>
                        <ExternalLink href={pr.url} variant="inline" testId="pr-waiting-link">
                          Open
                        </ExternalLink>
                        {inFlight(pr) ? (
                          <span
                            className="text-neutral-600 dark:text-neutral-400"
                            data-testid="pr-merging"
                          >
                            Merging…
                          </span>
                        ) : pr.merge?.canMerge !== false ? (
                          <Button
                            variant="secondary"
                            className="px-2 py-0.5 text-xs"
                            disabled={busy || following}
                            title={
                              pr.merge?.first.length
                                ? `Merges ${andWords(pr.merge.first.map((n) => `#${n}`))} first, then this one.`
                                : "Puts it into main with a merge commit."
                            }
                            onClick={() => void press(pr)}
                            data-testid="pr-merge"
                          >
                            Merge
                          </Button>
                        ) : null}
                        {pr.merge?.first.length && pr.merge.canMerge && !inFlight(pr) ? (
                          <span className="text-xs text-neutral-500" data-testid="pr-merge-first">
                            Merges {andWords(pr.merge.first.map((n) => `#${n}`))} first.
                          </span>
                        ) : null}
                        {pr.merge?.sentence ? (
                          <span
                            className="basis-full text-xs text-neutral-600 dark:text-neutral-400"
                            data-testid="pr-merge-sentence"
                          >
                            {pr.merge.sentence}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
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

/** How often the Overview reads the pull requests again while a Merge it pressed runs. */
export const MERGE_POLL_MS = 1500;

/**
 * What a Merge came to once none of its pull requests is in flight: "Merged #2, #3 and #4."
 * when all are gone from the list (merged); otherwise those not merged, whose rows each say why
 * (a check failed, it waits for its checks or behind one that does, a rule): "Merged #2. #3 and
 * #4 are not merged yet: each row below says why."
 */
function pressedOutcome(order: readonly number[], waiting: readonly ProjectPullRequestView[]) {
  const name = (n: number) => `#${n}`;
  const left = order.filter((n) => waiting.some((w) => w.number === n));
  const merged = order.filter((n) => !left.includes(n));
  const done = merged.length ? `Merged ${andWords(merged.map(name))}.` : "";
  if (!left.length) return done;
  const notYet =
    left.length === 1
      ? `${name(left[0] as number)} is not merged yet: the row below says why.`
      : `${andWords(left.map(name))} are not merged yet: each row below says why.`;
  return done ? `${done} ${notYet}` : notYet;
}

/** "#2, #3 and #4". */
function andWords(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
