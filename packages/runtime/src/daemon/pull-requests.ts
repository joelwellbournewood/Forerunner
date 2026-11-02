import type { GitHost, PullRequestInfo, RepoRef } from "@forerunner/capabilities";
import { ACCEPTED_WITHOUT_REVIEW } from "@forerunner/critic";
import { errorMessage, isAbsolute, redact } from "@forerunner/platform";
import type { ProjectRow, StateStore, TaskRow } from "@forerunner/state";
import {
  DOCS_SCAFFOLD_BRANCH,
  isDocsBranch,
  isProjectDocsPr,
  parseRepoRef,
  STATUS_BRANCH,
} from "../loop/docs.ts";
import { ACCEPTED_AT_SIGNOFF } from "../session/findings.ts";
import type {
  ProjectPullRequestsView,
  ProjectPullRequestView,
  ProjectRepositoryView,
} from "./api-types.ts";

/**
 * Where a repository project's work is, for the person (core-experience design §3.4 "Your
 * files", §3.10): the linked repository with its link, and the pull requests that wait for the
 * person to merge them. Before (GitHub walk, 2026-11-02) the session result said "5 reviewed
 * pull requests wait for you to merge" and nothing on the Overview, the session page or the
 * Inbox linked one; the repository was shown nowhere on the project page, and "Your files"
 * named this install's docs clone, which held none of the unmerged work. Each PR says who
 * checked it (`review`): the review (2026-11-02) found Forerunner's own docs PRs listed under
 * "Reviewed by the critic".
 */

/**
 * The repository's page from the GitHub API base the install talks to: `api.github.com` is
 * github.com; GitHub Enterprise and the fake git host serve their pages at the API's origin.
 */
export function repoWebUrl(apiBase: string | undefined, ref: RepoRef): string {
  let base: URL;
  try {
    base = new URL(apiBase || "https://api.github.com");
  } catch {
    base = new URL("https://api.github.com");
  }
  const origin = base.hostname === "api.github.com" ? "https://github.com" : base.origin;
  return `${origin}/${ref.owner}/${ref.name}`;
}

/** The repository a project is linked to; null without one or for a local folder (spec A.4). */
export function projectRepository(
  project: Pick<ProjectRow, "repos">,
  apiBase?: string,
): ProjectRepositoryView | null {
  const first = project.repos[0]?.trim() ?? "";
  if (!first || isAbsolute(first)) return null;
  const ref = parseRepoRef(first);
  if (!ref) return null;
  return { fullName: `${ref.owner}/${ref.name}`, url: repoWebUrl(apiBase, ref) };
}

/** What a docs pull request holds, in the person's words. */
function docsTitle(branch: string): string {
  if (branch === STATUS_BRANCH) return "Project status (docs/status.md)";
  if (branch === DOCS_SCAFFOLD_BRANCH) return "The project's standard docs";
  return "The project's docs from the plan";
}

/**
 * Who checked a done task's work, for the words its PR is listed under: the person's own
 * acceptance at sign-off, a close without the critic's review (Mark done anyway, checks only),
 * or the critic's accepting review. The critic's is read from its last review of the task, not
 * the reason: at level 2 the merge writes "PR left open for you: ..." over the critic's words.
 */
async function reviewOf(
  store: StateStore,
  task: TaskRow,
): Promise<NonNullable<ProjectPullRequestView["review"]>> {
  if (task.reason.startsWith(ACCEPTED_WITHOUT_REVIEW)) return "none";
  if (task.reason.startsWith(ACCEPTED_AT_SIGNOFF)) return "you";
  const review = await store.review.latestForTask(task.id);
  return review?.verdict === "accept" ? "critic" : "none";
}

/**
 * The open pull requests that wait for the person: each done task's (nothing merged it: below
 * level 3 Trusted, merging is the person's), with who checked it (`reviewOf`), and Forerunner's
 * docs PRs (the scaffold, the intake's set, the status). A task still running or in review is not
 * waiting for a merge; a PR of someone else's is not listed. Read from the host when shown, so
 * a PR merged on GitHub is gone at once; a host that does not answer is said in words.
 */
export async function projectPullRequests(
  deps: { store: StateStore; host: GitHost; apiBase?: string },
  project: ProjectRow,
): Promise<ProjectPullRequestsView> {
  const repository = projectRepository(project, deps.apiBase);
  const ref = repository ? parseRepoRef(repository.fullName) : null;
  if (!repository || !ref) return { repository: null, waiting: [], error: null };
  let prs: PullRequestInfo[];
  try {
    prs = await deps.host.listPullRequests(ref, { state: "open" });
  } catch (e) {
    return {
      repository,
      waiting: [],
      error: `GitHub did not answer, so the pull requests are not listed (${redact(errorMessage(e)).slice(0, 160)}). Try again later.`,
    };
  }
  const tasks = await deps.store.task.list({ project_id: project.id } as never, { limit: 2000 });
  const waiting: ProjectPullRequestView[] = [];
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const task = tasks.find((t) => t.branch === pr.head.ref || t.pr_url === pr.htmlUrl);
    if (task) {
      if (task.status !== "done") continue;
      waiting.push({
        kind: "task",
        taskId: task.id,
        title: task.title,
        number: pr.number,
        url: pr.htmlUrl,
        branch: pr.head.ref,
        review: await reviewOf(deps.store, task),
      });
    } else if (isDocsBranch(pr.head.ref) && isProjectDocsPr(project, pr)) {
      // Only this project's docs PRs (L-16): live, another project's stale scaffold PR on the
      // same repository was listed as "The project's standard docs".
      waiting.push({
        kind: "docs",
        taskId: null,
        title: docsTitle(pr.head.ref),
        number: pr.number,
        url: pr.htmlUrl,
        branch: pr.head.ref,
        review: null,
      });
    }
  }
  return { repository, waiting, error: null };
}
