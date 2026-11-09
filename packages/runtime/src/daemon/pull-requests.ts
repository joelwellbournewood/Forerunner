import type { GitHost, PullRequestInfo, RepoRef } from "@forerunner/capabilities";
import { ACCEPTED_WITHOUT_REVIEW } from "@forerunner/critic";
import { errorMessage, ForerunnerError, isAbsolute, log, redact } from "@forerunner/platform";
import type { MergeRecordRow, ProjectRow, StateStore, TaskRow } from "@forerunner/state";
import {
  DOCS_SCAFFOLD_BRANCH,
  isDocsBranch,
  isProjectDocsPr,
  parseRepoRef,
  STATUS_BRANCH,
} from "../loop/docs.ts";
import { buildsOnSentence, type ReviewedPrMerge, rulesBlock } from "../loop/merge.ts";
import {
  MERGE_MODE_WORDS,
  type MergeMode,
  mergeModeOf,
  mergesAfterSentence,
} from "../loop/merge-mode.ts";
import type { TaskTakeOut } from "../loop/take-out.ts";
import { ACCEPTED_AT_SIGNOFF } from "../session/findings.ts";
import type {
  ProjectPullRequestsView,
  ProjectPullRequestView,
  ProjectRepositoryView,
  PullRequestMergeAnswer,
  PullRequestPreviewAnswer,
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

/** The words of the merge step this view needs (merge-in-app), as `ReviewedPrMerge` has them. */
export type InAppMergePort = Pick<
  ReviewedPrMerge,
  "approveInOrder" | "mergeApproved" | "mergeAsIs"
>;

export interface ProjectPullRequestsDeps {
  store: StateStore;
  host: GitHost;
  apiBase?: string;
  /**
   * Whether a GitHub token is saved (C-56): without one GitHub is never asked, and the view says
   * so with Connect GitHub. Absent: the host is asked.
   */
  hasToken?: () => Promise<boolean>;
  /** The merge step (merge-in-app): the person's Merge goes through it. Absent: no Merge. */
  merge?: InAppMergePort;
  /** The install's agent: a docs pull request merged as it is is its. */
  agentId?: string;
  /** A merge in the background ended (merged or not): the project's screens read again. */
  changed?: (projectId: string) => void;
  /**
   * The project's pull request preview beside its copy (merged-actions: `ProjectDocs`'s
   * `previewPullRequest`, `previewOf`, `dropPreview`). Absent: no "Open this version".
   */
  previews?: PullRequestPreviewPort;
  /**
   * "Take this work out" (merged-actions, `TaskTakeOut`): the open take-out pull requests are
   * listed as `take_out` rows with Merge (as they are, on the click), and one no longer open is
   * settled as merged or closed. Absent: none is listed.
   */
  takeOuts?: Pick<TaskTakeOut, "openOf" | "settle" | "merged">;
}

/** "Open this version" of a waiting pull request (merged-actions), as `ProjectDocs` has it. */
export interface PullRequestPreviewPort {
  previewPullRequest(
    project: ProjectRow,
    pr: { number: number; headRef: string; headSha: string },
  ): Promise<{ folder: string; number: number; combined: boolean; base: string }>;
  previewOf(
    projectId: string,
  ): { number: number; folder: string; combined: boolean; base: string } | null;
  dropPreview(projectId: string, number?: number): Promise<boolean>;
}

/**
 * Why "Open this version" could not put a pull request's version on this computer (design §5.8:
 * what went wrong and what to do). P7-24 (polish-words): a file of the old version open in another
 * program (Windows' EBUSY or EPERM) is the one cause the person can fix here, so it is said.
 */
export function previewFailedSentence(number: number, e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const busy =
    code === "EBUSY" ||
    code === "EPERM" ||
    /\b(EBUSY|EPERM)\b|resource busy|being used by another process/i.test(errorMessage(e));
  return busy
    ? `#${number}'s version could not be put on this computer: a file of it is open in another program. Close it and try again.`
    : `#${number}'s version could not be put on this computer. Try again, or open it on GitHub.`;
}

/** What a preview's row says with its folder (design §5: what it is, and that nothing is kept). */
export function previewSentence(number: number, combined: boolean, base: string): string {
  return combined
    ? `#${number} as it would be merged. Changes here are not kept.`
    : `#${number} as its branch has it: it does not merge cleanly with ${base} yet. Changes here are not kept.`;
}

/** The record outcomes a click cannot get past: the person acts on GitHub (or Redo). */
const NO_CLICK: ReadonlySet<string> = new Set([
  "checks_failed",
  "conflict",
  "head_moved",
  "blocked_by_rules",
  "merge_commits_off",
  "rebuild_conflict",
  "closed",
]);

/** "#4" for a pull request in a sentence. */
const prName = (n: number) => `#${n}`;

function andList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The sentence a record says on the Overview: none where the row's own Merge says it. */
function rowSentence(record: MergeRecordRow): string | null {
  const s = record.sentence.trim();
  if (!s || /press Merge on the Overview\.?$/.test(s)) return null;
  return s;
}

/** What Merge does for a task's pull request, from its merge record (ADR 0111). */
function mergeOfRecord(
  record: MergeRecordRow | undefined,
  pr: number,
  mode: MergeMode,
): NonNullable<ProjectPullRequestView["merge"]> {
  const none = { first: [] as number[] };
  if (!record) return { state: "ready", canMerge: true, sentence: null, ...none };
  switch (record.state) {
    case "queued":
      // The person's Merge, waiting its turn; or an accept whose merge has not run yet, which
      // the automatic mode merges by itself and "You press Merge" leaves for the click.
      if (record.approval === "person")
        return { state: "queued", canMerge: false, sentence: null, ...none };
      return mode === "after_review"
        ? { state: "merging", canMerge: false, sentence: null, ...none }
        : { state: "ready", canMerge: true, sentence: null, ...none };
    case "merging":
    case "merged":
      // Merged on the record while the host still lists it open: it is a moment away.
      return { state: "merging", canMerge: false, sentence: null, ...none };
    case "waiting_checks":
      return {
        state: "waiting_checks",
        canMerge: false,
        sentence: record.sentence.trim() || `${prName(pr)} merges when its checks pass.`,
        ...none,
      };
    default:
      return NO_CLICK.has(record.last_outcome ?? "")
        ? { state: "blocked", canMerge: false, sentence: rowSentence(record), ...none }
        : { state: "left_to_you", canMerge: true, sentence: rowSentence(record), ...none };
  }
}

/**
 * A repository project's pull requests that wait for the person, and the person's Merge in the
 * app (merge-in-app, the owner's decision of 2026-11-02: "you press Merge" with a one-click Merge
 * on the Overview, in dependency order, merge commits only, the safe merge step).
 *
 * `view`: the open pull requests that wait for the person (each done task's, with who checked it,
 * `reviewOf`; Forerunner's docs pull requests, the scaffold, the intake's set and the status),
 * read from the host when shown, so a pull request merged on GitHub is gone at once. Each row
 * says what Merge does (`merge`, from the task's merge record): offered, under way, merging when
 * its checks pass, or why not (a rule Forerunner cannot meet and merge commits off are read once
 * per view from the repository, so a row never offers a Merge that cannot happen; what it builds
 * on is not accepted yet). A row that builds on other open pull requests names them (`first`):
 * Merge merges those first. A task still running or in review is not waiting for a merge; a
 * pull request of someone else's is not listed. GitHub's own refusals are said in words (C-56):
 * no token (GitHub never asked), a refused token, GitHub not answering (the error to the log).
 *
 * `merge`: the person pressed Merge. The answer comes at once: the records of the chain (what it
 * builds on first) are approved by the person and queued, persisted, and the merges then run in
 * the background through the merge step (`ReviewedPrMerge.approveInOrder`, `mergeApproved`), each
 * with a merge commit; one that waits for its checks is finished by the watcher's retry pass,
 * after a restart too. A docs pull request merges as it is on GitHub now (`mergeAsIs`), never
 * unattended in either mode.
 */
export class ProjectPullRequests {
  private readonly logger = log("pull-requests");
  private readonly running = new Set<Promise<unknown>>();
  /** A docs pull request's Merge (it has no record): its outcome until the row is gone. */
  private readonly docs = new Map<
    string,
    { state: "merging" | "left_to_you"; sentence: string | null }
  >();

  constructor(private readonly deps: ProjectPullRequestsDeps) {}

  async view(project: ProjectRow): Promise<ProjectPullRequestsView> {
    const { store, host } = this.deps;
    const mode = mergeModeOf(project.settings);
    const modeView = { key: mode, label: MERGE_MODE_WORDS[mode] };
    const repository = projectRepository(project, this.deps.apiBase);
    const ref = repository ? parseRepoRef(repository.fullName) : null;
    if (!repository || !ref)
      return { repository: null, waiting: [], error: null, errorKind: null, mode: modeView };
    if (this.deps.hasToken && !(await this.deps.hasToken().catch(() => false)))
      return {
        repository,
        waiting: [],
        error: "Add a GitHub token in Settings to see the pull requests.",
        errorKind: "no_token",
        mode: modeView,
      };
    let prs: PullRequestInfo[];
    try {
      prs = await host.listPullRequests(ref, { state: "open" });
    } catch (e) {
      // The words for the person, the error for the log (C-56: the raw error was on the screen).
      this.logger.warn("pull requests not listed", {
        projectId: project.id,
        error: redact(errorMessage(e)).slice(0, 300),
      });
      const code = e instanceof ForerunnerError ? e.code : "";
      if (code === "provider_auth")
        return {
          repository,
          waiting: [],
          error:
            "GitHub refused the saved token, so the pull requests are not listed: save a new one in Settings.",
          errorKind: "refused",
          mode: modeView,
        };
      if (code === "tool_not_allowed" || code === "not_found")
        return {
          repository,
          waiting: [],
          error: `The saved GitHub token cannot read ${repository.fullName}: give it access to the repository, or save another one in Settings.`,
          errorKind: "refused",
          mode: modeView,
        };
      return {
        repository,
        waiting: [],
        error: "GitHub did not answer, so the pull requests are not listed. Try again later.",
        errorKind: "unreachable",
        mode: modeView,
      };
    }
    const blockedBy = await this.rulesOf(ref, prs);
    const tasks = await store.task.list({ project_id: project.id } as never, { limit: 2000 });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const rows: ProjectPullRequestView[] = [];
    const taskOfRow = new Map<number, TaskRow>();
    // merged-actions: the take-outs that wait, by their pull request's number; one no longer
    // open on the host is settled (merged or closed) first.
    const takeOuts = this.deps.takeOuts;
    if (takeOuts)
      await takeOuts.settle(project.id, prs).catch((e: unknown) => {
        this.logger.warn("take-outs not settled", {
          projectId: project.id,
          error: errorMessage(e),
        });
      });
    const takingOut = takeOuts
      ? await takeOuts.openOf(project.id).catch(() => new Map<number, MergeRecordRow>())
      : new Map<number, MergeRecordRow>();
    for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
      const rule = blockedBy.get(pr.base.ref) ?? null;
      const ruleSentence = rule ? rule(pr.number) : null;
      const takeOut = takingOut.get(pr.number);
      if (takeOut) {
        // It has no record of its own: Merge merges it as it is, on the click.
        const of = byId.get(takeOut.task_id);
        const clicked = this.docs.get(pr.htmlUrl);
        rows.push({
          kind: "take_out",
          taskId: takeOut.task_id,
          title: of ? `Take out: ${of.title}` : pr.title,
          number: pr.number,
          url: pr.htmlUrl,
          branch: pr.head.ref,
          review: null,
          merge: ruleSentence
            ? { state: "blocked", canMerge: false, sentence: ruleSentence, first: [] }
            : clicked?.state === "merging"
              ? { state: "merging", canMerge: false, sentence: null, first: [] }
              : {
                  state: clicked ? "left_to_you" : "ready",
                  canMerge: true,
                  sentence: clicked?.sentence ?? null,
                  first: [],
                },
        });
        continue;
      }
      const task = tasks.find((t) => t.branch === pr.head.ref || t.pr_url === pr.htmlUrl);
      if (task) {
        if (task.status !== "done") continue;
        const record = await store.mergeRecord.forTask(task.id);
        const own = mergeOfRecord(
          record?.pr_number === pr.number ? record : undefined,
          pr.number,
          mode,
        );
        taskOfRow.set(pr.number, task);
        rows.push({
          kind: "task",
          taskId: task.id,
          title: task.title,
          number: pr.number,
          url: pr.htmlUrl,
          branch: pr.head.ref,
          review: await reviewOf(store, task),
          merge: ruleSentence
            ? { state: "blocked", canMerge: false, sentence: ruleSentence, first: [] }
            : own,
        });
      } else if (isDocsBranch(pr.head.ref) && isProjectDocsPr(project, pr)) {
        // Only this project's docs PRs (L-16): live, another project's stale scaffold PR on the
        // same repository was listed as "The project's standard docs".
        const clicked = this.docs.get(pr.htmlUrl);
        rows.push({
          kind: "docs",
          taskId: null,
          title: docsTitle(pr.head.ref),
          number: pr.number,
          url: pr.htmlUrl,
          branch: pr.head.ref,
          review: null,
          merge: ruleSentence
            ? { state: "blocked", canMerge: false, sentence: ruleSentence, first: [] }
            : clicked?.state === "merging"
              ? { state: "merging", canMerge: false, sentence: null, first: [] }
              : {
                  state: clicked ? "left_to_you" : "ready",
                  canMerge: true,
                  sentence: clicked?.sentence ?? null,
                  first: [],
                },
        });
      }
    }
    // Dependency order: what each task's pull request builds on merges first.
    const rowOfTask = new Map<string, ProjectPullRequestView>();
    for (const row of rows) if (row.taskId && row.kind === "task") rowOfTask.set(row.taskId, row);
    // Each row's own state, before a row that waits behind another is said as waiting (below).
    const ownState = new Map(rows.map((r) => [r.number, r.merge?.state]));
    for (const row of rows) {
      const task = row.taskId && row.kind === "task" ? byId.get(row.taskId) : undefined;
      if (!task || !row.merge) continue;
      const chain = this.chainOf(task, byId, rowOfTask);
      row.merge.first = chain.first;
      // The person's Merge, queued behind pull requests whose checks still run: it waits its
      // turn and says so; nothing about it is in flight until those merge (review, 2026-11-08:
      // it said "Merging…" for as long as the checks ran, and the Overview read the list every
      // 1.5 s all that time). The merge of the one before it is a project event: the Overview
      // reads the list again then.
      const waitingOn = chain.first.filter((n) => ownState.get(n) === "waiting_checks");
      if (row.merge.state === "queued" && waitingOn.length) {
        row.merge = {
          state: "waiting_checks",
          canMerge: false,
          sentence: mergesAfterSentence(row.number, chain.first, waitingOn),
          first: chain.first,
        };
        continue;
      }
      if (row.merge.state === "blocked" || !row.merge.canMerge) continue;
      if (chain.notAccepted) {
        row.merge = {
          ...row.merge,
          state: "blocked",
          canMerge: false,
          sentence: `${prName(row.number)} builds on "${chain.notAccepted}", which is not accepted yet: it can merge once that one is.`,
        };
        continue;
      }
      const stuck = chain.first
        .map((n) => rows.find((r) => r.number === n))
        .find((r) => r?.merge && r.merge.state === "blocked");
      if (stuck)
        row.merge = {
          ...row.merge,
          state: "blocked",
          canMerge: false,
          sentence: buildsOnSentence(row.number, stuck.number),
        };
    }
    for (const [url] of this.docs) if (!prs.some((p) => p.htmlUrl === url)) this.docs.delete(url);
    await this.attachPreview(project.id, prs, rows);
    return { repository, waiting: rows, error: null, errorKind: null, mode: modeView };
  }

  /**
   * The project's preview on its pull request's row (merged-actions); a preview whose pull
   * request is no longer open (merged or closed on GitHub, and the watcher has not said so yet)
   * is removed now.
   */
  private async attachPreview(
    projectId: string,
    open: readonly PullRequestInfo[],
    rows: ProjectPullRequestView[],
  ): Promise<void> {
    const previews = this.deps.previews;
    if (!previews) return;
    const now = previews.previewOf(projectId);
    if (!now) return;
    if (!open.some((p) => p.number === now.number)) {
      await previews.dropPreview(projectId, now.number).catch((e: unknown) => {
        this.logger.warn("pull request preview not removed", { projectId, error: errorMessage(e) });
      });
      return;
    }
    const row = rows.find((r) => r.number === now.number);
    if (row)
      row.preview = {
        folder: now.folder,
        sentence: previewSentence(now.number, now.combined, now.base),
      };
  }

  /**
   * "Open this version" (merged-actions): the waiting pull request `number`'s files on this
   * computer, beside the project's copy and under its lock (`ProjectDocs.previewPullRequest`),
   * replacing the project's earlier preview. Only a pull request the Overview lists as waiting.
   */
  async preview(project: ProjectRow, number: number): Promise<PullRequestPreviewAnswer> {
    const refused = (sentence: string): PullRequestPreviewAnswer => ({
      state: "refused",
      sentence,
      folder: null,
      number,
    });
    const previews = this.deps.previews;
    if (!previews) return refused("Opening a pull request's version is not available here.");
    const repository = projectRepository(project, this.deps.apiBase);
    const ref = repository ? parseRepoRef(repository.fullName) : null;
    if (!ref) return refused("This project has no repository.");
    const view = await this.view(project);
    if (view.error) return refused(view.error);
    if (!view.waiting.some((r) => r.number === number))
      return refused(
        `${prName(number)} does not wait to be merged: it may be merged or closed already.`,
      );
    let pr: PullRequestInfo;
    try {
      pr = await this.deps.host.getPullRequest(ref, number);
    } catch (e) {
      this.logger.warn("pull request not read for its preview", {
        projectId: project.id,
        error: redact(errorMessage(e)).slice(0, 300),
      });
      return refused("GitHub did not answer, so its version was not opened. Try again later.");
    }
    try {
      const out = await previews.previewPullRequest(project, {
        number,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
      });
      return {
        state: "ready",
        sentence: previewSentence(number, out.combined, out.base),
        folder: out.folder,
        number,
      };
    } catch (e) {
      this.logger.warn("pull request preview failed", {
        projectId: project.id,
        pr: number,
        error: redact(errorMessage(e)).slice(0, 300),
      });
      return refused(
        e instanceof ForerunnerError && e.code === "not_found"
          ? e.message
          : previewFailedSentence(number, e),
      );
    }
  }

  /**
   * The person pressed Merge on pull request `number` of `project`: answered at once (above).
   * `humanId` is the person; their click is the approval of each merge in the chain.
   */
  async merge(
    project: ProjectRow,
    number: number,
    humanId: string,
  ): Promise<PullRequestMergeAnswer> {
    const { merge, store } = this.deps;
    const refused = (sentence: string): PullRequestMergeAnswer => ({
      state: "refused",
      sentence,
      order: [],
    });
    if (!merge) return refused("Merging in the app is not available here: merge it on GitHub.");
    const view = await this.view(project);
    if (view.error) return refused(view.error);
    const row = view.waiting.find((r) => r.number === number);
    if (!row)
      return refused(
        `${prName(number)} does not wait to be merged: it may be merged or closed already.`,
      );
    if (!row.merge?.canMerge)
      return refused(
        row.merge?.sentence ??
          (row.merge?.state === "waiting_checks" ||
          row.merge?.state === "merging" ||
          row.merge?.state === "queued"
            ? `${prName(number)} is being merged.`
            : `${prName(number)} cannot be merged here: merge it on GitHub.`),
      );
    if (row.kind === "docs" || row.kind === "take_out") {
      this.docs.set(row.url, { state: "merging", sentence: null });
      this.background(project.id, async () => {
        const out = await merge.mergeAsIs({
          prUrl: row.url,
          projectId: project.id,
          agentId: this.deps.agentId ?? "",
          humanId,
        });
        if (out.status === "merged") {
          this.docs.delete(row.url);
          // merged-actions: the task's row reads "Taken out in #9".
          if (row.kind === "take_out") await this.deps.takeOuts?.merged(project.id, row.number);
        } else this.docs.set(row.url, { state: "left_to_you", sentence: out.sentence });
      });
      return {
        state: "queued",
        sentence: `Merging ${prName(number)} as it is on GitHub now.`,
        order: [number],
      };
    }
    const order = [...row.merge.first, number];
    const chain: TaskRow[] = [];
    let asItIs = false;
    for (const n of order) {
      const r = view.waiting.find((w) => w.number === n);
      const task = r?.taskId ? await store.task.get(r.taskId) : undefined;
      if (!task) continue;
      if (!(await store.mergeRecord.forTask(task.id))?.reviewed_head_sha) asItIs = true;
      chain.push(task);
    }
    // The person's approval is on the records before the answer: a restart finishes them.
    const records = await merge.approveInOrder(chain, humanId);
    this.background(project.id, () => merge.mergeApproved(records, humanId));
    const names = andList(order.map(prName));
    return {
      state: "queued",
      sentence:
        order.length > 1
          ? `Merging ${names} in order.`
          : asItIs
            ? `Merging ${names} as it is on GitHub now.`
            : `Merging ${names}.`,
      order,
    };
  }

  /** Every merge started here has ended (tests, the daemon's close). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private background(projectId: string, fn: () => Promise<unknown>): void {
    const p: Promise<unknown> = fn()
      .catch((e: unknown) => {
        this.logger.warn("merge in the app failed", { projectId, error: errorMessage(e) });
      })
      .finally(() => {
        this.running.delete(p);
        this.deps.changed?.(projectId);
      });
    this.running.add(p);
  }

  /**
   * The pull requests a task's builds on that are open and wait for a merge, in the order they
   * merge (theirs first), and the first dependency that is not accepted yet.
   */
  private chainOf(
    task: TaskRow,
    byId: ReadonlyMap<string, TaskRow>,
    rowOfTask: ReadonlyMap<string, ProjectPullRequestView>,
    seen = new Set<string>(),
  ): { first: number[]; notAccepted: string | null } {
    const first: number[] = [];
    let notAccepted: string | null = null;
    for (const id of task.depends_on ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const dep = byId.get(id);
      if (!dep) continue;
      if (dep.status !== "done" && dep.status !== "cancelled") {
        notAccepted ??= dep.title;
        continue;
      }
      const depRow = rowOfTask.get(dep.id);
      if (!depRow) continue;
      const inner = this.chainOf(dep, byId, rowOfTask, seen);
      notAccepted ??= inner.notAccepted;
      for (const n of [...inner.first, depRow.number]) if (!first.includes(n)) first.push(n);
    }
    return { first, notAccepted };
  }

  /**
   * What the repository's settings and each base branch's rules let Forerunner merge, read once
   * per view (ADR 0111 points 5 and 6): a sentence per pull request where they let it merge
   * nothing; nothing when they could not be read (the merge step reads them again).
   */
  private async rulesOf(
    ref: RepoRef,
    prs: readonly PullRequestInfo[],
  ): Promise<Map<string, (n: number) => string>> {
    const out = new Map<string, (n: number) => string>();
    if (!prs.length) return out;
    try {
      const repo = await this.deps.host.getRepo(ref);
      for (const base of new Set(prs.map((p) => p.base.ref))) {
        if (repo.allowMergeCommit === false) {
          out.set(
            base,
            (n) =>
              `This repository does not allow merge commits, and Forerunner merges only with one: merge ${prName(n)} on GitHub, or allow merge commits in its settings.`,
          );
          continue;
        }
        const rules = await this.deps.host.getBranchRules(ref, base);
        if (rulesBlock(rules, 0, base))
          out.set(base, (n) => rulesBlock(rules, n, base)?.sentence ?? "");
      }
    } catch (e) {
      this.logger.warn("branch rules not read", { error: errorMessage(e) });
    }
    return out;
  }
}

/** The view alone (`ProjectPullRequests.view`), for a caller without the merge. */
export async function projectPullRequests(
  deps: ProjectPullRequestsDeps,
  project: ProjectRow,
): Promise<ProjectPullRequestsView> {
  return new ProjectPullRequests(deps).view(project);
}
