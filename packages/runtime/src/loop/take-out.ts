import {
  type GitHost,
  type PullRequestInfo,
  type TakeOutGitResult,
  taskBranchName,
} from "@forerunner/capabilities";
import { errorMessage, log, redact } from "@forerunner/platform";
import type { MergeMethod, MergeRecordRow, StateStore, TaskRow } from "@forerunner/state";
import type { TaskTakeOutAnswer } from "../daemon/api-types.ts";
import {
  andList,
  quoted,
  TAKE_OUT_NOTICE_PREFIX,
  takeOutConflictSentence,
  takeOutOpenedSentence,
  unknownShapeSentence,
} from "../daemon/take-out-words.ts";
import { parsePullUrl } from "./merge.ts";

/**
 * "Take this work out" on a merged task (merged-actions, the owner's decision of 2026-11-02 on
 * merging: "'Take this work out' (revert PR naming later tasks that built on it)"). Before,
 * Done was final, Undo could not reach a merge and nothing reverted a merged pull request; a
 * pull request the person merged on GitHub by squash or rebase has a merge commit with one
 * parent or several copied commits, so `git revert -m 1` on the recorded commit would fail or
 * undo only part of it.
 *
 * `TaskTakeOut.takeOut(taskId)` reads the task's merged pull request (its merge record's merge
 * commit, else the host's), names the done tasks that built on it (`builtOn`), and asks the PR
 * executor (`PrTaskExecutor.takeOut`) for a branch from the default branch that reverts it by
 * the way it was merged (a merge commit, a squash, a rebase; anything else is refused with
 * `unknownShapeSentence`). The branch is pushed (never the default branch) and a pull request
 * "Take out: <title>" is opened whose body names those tasks; the task's merge record keeps it
 * (`take_out_pr_number`, `take_out_pr_url`, `take_out_state: "open"`), so its row reads "Taken
 * out in #9 (waiting for you to merge)" and the Overview lists it under Waiting for you to merge
 * with Merge (it has no record of its own, so it merges as it is, on the click). A revert that
 * conflicts with later work pushes nothing and files one Inbox notice (`TAKE_OUT_NOTICE_PREFIX`).
 */

/** The notice of a take-out that conflicted: one per task while it is open. */
export { TAKE_OUT_NOTICE_PREFIX };

/** What `PrTaskExecutor` does in git for it. */
export interface TakeOutGitPort {
  takeOut(req: {
    task: TaskRow;
    number: number;
    mergeSha: string;
    headSha: string | null;
    branch: string;
  }): Promise<TakeOutGitResult>;
}

export interface TaskTakeOutDeps {
  store: StateStore;
  host: GitHost;
  /** The PR executor (null: no repository work in this install). */
  git: TakeOutGitPort | null;
  humanId: string;
  agentId: string;
  /** A take-out opened, merged or closed: the project's screens read again. */
  changed?: (projectId: string) => void;
}

/**
 * "merged" / "squash-merged" / "rebase-merged" for the pull request's words; "merged" when git
 * cannot tell a squash from a rebase (a pull request of one commit, `sure` false).
 */
function mergedHow(how: MergeMethod, sure: boolean): string {
  if (!sure) return "merged";
  return how === "squash" ? "squash-merged" : how === "rebase" ? "rebase-merged" : "merged";
}

/** The take-out pull request's body. */
function takeOutBody(
  task: TaskRow,
  number: number,
  how: { how: MergeMethod; sure: boolean },
  builtOn: readonly string[],
): string {
  const lines = [
    `Takes out the work of ${quoted(task.title)} (#${number}, ${mergedHow(how.how, how.sure)}): it reverts that change on a branch of its own. Nothing reaches the default branch until you merge this.`,
    "",
    builtOn.length
      ? `Later tasks built on it: ${andList(builtOn.map(quoted))}. Their work may need it: check them before you merge this.`
      : "No later task built on it.",
    "",
    'Opened by Forerunner when you pressed "Take this work out".',
  ];
  return lines.join("\n");
}

export class TaskTakeOut {
  private readonly logger = log("take-out");

  constructor(private readonly deps: TaskTakeOutDeps) {}

  /** The done tasks that built on `task`, directly or through another, oldest first. */
  async builtOn(task: TaskRow): Promise<TaskRow[]> {
    const all = await this.deps.store.task.list({ project_id: task.project_id } as never, {
      limit: 2000,
    });
    const out: TaskRow[] = [];
    const seen = new Set([task.id]);
    let frontier = [task.id];
    while (frontier.length) {
      const next: string[] = [];
      for (const t of all)
        if (!seen.has(t.id) && t.depends_on.some((d) => frontier.includes(d))) {
          seen.add(t.id);
          next.push(t.id);
          if (t.status === "done") out.push(t);
        }
      frontier = next;
    }
    return out;
  }

  /**
   * "Take this work out" on task `taskId` (see the module comment). One at a time per task: a
   * second press while the first runs is refused, so two clicks never open two pull requests.
   */
  async takeOut(taskId: string): Promise<TaskTakeOutAnswer> {
    if (this.running.has(taskId))
      return {
        state: "refused",
        sentence: "Its work is being taken out now: the answer comes in a moment.",
        number: null,
        url: null,
        builtOn: [],
      };
    this.running.add(taskId);
    try {
      return await this.takeOutNow(taskId);
    } finally {
      this.running.delete(taskId);
    }
  }

  /** The tasks whose take-out runs now in this process. */
  private readonly running = new Set<string>();

  private async takeOutNow(taskId: string): Promise<TaskTakeOutAnswer> {
    const { store, host } = this.deps;
    const refused = (sentence: string, builtOn: string[] = []): TaskTakeOutAnswer => ({
      state: "refused",
      sentence,
      number: null,
      url: null,
      builtOn,
    });
    const task = await store.task.get(taskId);
    if (!task) return refused("That task no longer exists.");
    if (task.status !== "done")
      return refused(`${quoted(task.title)} is not done, so it has no merged work to take out.`);
    const ref = task.pr_url ? parsePullUrl(task.pr_url) : null;
    if (!ref)
      return refused(
        `${quoted(task.title)} has no pull request, so there is nothing to take out of main.`,
      );
    const record = await store.mergeRecord.forTask(task.id);
    if (record?.take_out_pr_number && record.take_out_state === "open")
      return refused(
        `${quoted(task.title)} is being taken out in #${record.take_out_pr_number}: merge #${record.take_out_pr_number} to finish it.`,
      );
    if (record?.take_out_pr_number && record.take_out_state === "merged")
      return refused(`${quoted(task.title)} was taken out in #${record.take_out_pr_number}.`);
    if (!this.deps.git) return refused("Taking work out is not available here: undo it on GitHub.");
    let pr: PullRequestInfo;
    try {
      pr = await host.getPullRequest(ref.repo, ref.number);
    } catch (e) {
      this.logger.warn("pull request not read for a take-out", {
        taskId,
        error: redact(errorMessage(e)).slice(0, 300),
      });
      return refused("GitHub did not answer, so nothing was taken out. Try again later.");
    }
    if (!pr.merged)
      return refused(
        `#${ref.number} is not merged, so ${quoted(task.title)}'s work is not in main: close #${ref.number} on GitHub if you do not want it.`,
      );
    const mergeSha =
      (record?.state === "merged" && record.merge_sha) || pr.mergeCommitSha || record?.merge_sha;
    if (!mergeSha) return refused(unknownShapeSentence(ref.number));
    const later = (await this.builtOn(task)).map((t) => t.title);
    // Never the id's time part alone (R-branch): two tasks of one minute shared it.
    const branch = `${task.branch?.trim() || taskBranchName(task)}-take-out`;
    let done: TakeOutGitResult;
    try {
      done = await this.deps.git.takeOut({
        task,
        number: ref.number,
        mergeSha,
        headSha: pr.head.sha || null,
        branch,
      });
    } catch (e) {
      this.logger.warn("take-out failed", { taskId, error: redact(errorMessage(e)).slice(0, 500) });
      return refused(
        `${quoted(task.title)} was not taken out: GitHub or git refused it. Try again, or undo it on GitHub.`,
        later,
      );
    }
    switch (done.kind) {
      case "no_repository":
        return refused(`${quoted(task.title)}'s project has no repository.`);
      case "not_in_main":
        return refused(
          `#${ref.number}'s merge is not in main any more, so there is nothing to take out.`,
        );
      case "unknown_shape":
        return refused(unknownShapeSentence(ref.number), later);
      case "conflict": {
        const sentence = takeOutConflictSentence(task.title, done.files);
        await this.notice(task, sentence, done.files);
        return { state: "conflict", sentence, number: null, url: null, builtOn: later };
      }
      case "pushed":
        break;
    }
    let opened: PullRequestInfo;
    try {
      // An earlier take-out of the same task that was closed left its pull request closed: a
      // new one is opened for the new branch.
      opened = await host.createPullRequest(done.repo, {
        title: `Take out: ${task.title.replace(/\s+/g, " ").trim()}`,
        body: takeOutBody(task, ref.number, { how: done.how, sure: done.sure !== false }, later),
        head: done.branch,
        base: done.base,
      });
    } catch (e) {
      this.logger.warn("take-out pull request not opened", {
        taskId,
        error: redact(errorMessage(e)).slice(0, 500),
      });
      return refused(
        `The branch that takes ${quoted(task.title)} out is on GitHub, but its pull request did not open: open ${done.branch} on GitHub.`,
        later,
      );
    }
    await this.keep(task, record, {
      prNumber: ref.number,
      prUrl: task.pr_url ?? opened.htmlUrl,
      mergeSha,
      how: done.how,
      takeOut: opened,
    });
    this.logger.info("take-out opened", { taskId, pr: opened.number, how: done.how });
    this.deps.changed?.(task.project_id);
    return {
      state: "opened",
      sentence: takeOutOpenedSentence(task.title, opened.number, later),
      number: opened.number,
      url: opened.htmlUrl,
      builtOn: later,
    };
  }

  /**
   * The project's open take-outs, against the pull requests open on the host now: one no longer
   * open is read from the host and marked merged or closed (a closed one offers Take this work
   * out again). `open` null: read each from the host.
   */
  async settle(projectId: string, open: readonly PullRequestInfo[] | null): Promise<void> {
    const records = (
      await this.deps.store.mergeRecord.list({ project_id: projectId } as never, { limit: 2000 })
    ).filter((r) => r.take_out_state === "open" && r.take_out_pr_url);
    let moved = false;
    for (const r of records) {
      if (open?.some((p) => p.number === r.take_out_pr_number)) continue;
      const ref = parsePullUrl(r.take_out_pr_url ?? "");
      if (!ref) continue;
      try {
        const pr = await this.deps.host.getPullRequest(ref.repo, ref.number);
        if (pr.state === "open" && !pr.merged) continue;
        await this.deps.store.mergeRecord.patch(r.id, {
          take_out_state: pr.merged ? "merged" : "closed",
        });
        moved = true;
      } catch (e) {
        this.logger.warn("take-out not read", { recordId: r.id, error: errorMessage(e) });
      }
    }
    if (moved) this.deps.changed?.(projectId);
  }

  /** A take-out pull request merged on the person's click (the Overview's Merge). */
  async merged(projectId: string, number: number): Promise<void> {
    const records = await this.deps.store.mergeRecord.list({ project_id: projectId } as never, {
      limit: 2000,
    });
    for (const r of records)
      if (r.take_out_pr_number === number && r.take_out_state === "open")
        await this.deps.store.mergeRecord.patch(r.id, { take_out_state: "merged" });
  }

  /** The open take-out records of a project, by their pull request's number. */
  async openOf(projectId: string): Promise<Map<number, MergeRecordRow>> {
    const out = new Map<number, MergeRecordRow>();
    for (const r of await this.deps.store.mergeRecord.list({ project_id: projectId } as never, {
      limit: 2000,
    }))
      if (r.take_out_state === "open" && r.take_out_pr_number) out.set(r.take_out_pr_number, r);
    return out;
  }

  /** The task's merge record with its take-out (a record is made for a merge without one). */
  private async keep(
    task: TaskRow,
    record: MergeRecordRow | undefined,
    m: {
      prNumber: number;
      prUrl: string;
      mergeSha: string;
      how: MergeMethod;
      takeOut: PullRequestInfo;
    },
  ): Promise<void> {
    const takeOut = {
      take_out_pr_number: m.takeOut.number,
      take_out_pr_url: m.takeOut.htmlUrl,
      take_out_state: "open",
    };
    if (record) {
      // A record the watcher has not marked merged yet (the merge was on GitHub a moment ago)
      // says merged now: the host says so.
      const merged = record.merge_sha ? {} : { merge_sha: m.mergeSha, method: m.how };
      if (record.state === "merged")
        await this.deps.store.mergeRecord.patch(record.id, { ...takeOut, ...merged });
      else
        await this.deps.store.mergeRecord
          .move(record.id, "merged", { ...takeOut, ...merged })
          .catch(() => this.deps.store.mergeRecord.patch(record.id, { ...takeOut, ...merged }));
      return;
    }
    await this.deps.store.mergeRecord.insert({
      task_id: task.id,
      project_id: task.project_id,
      agent_id: this.deps.agentId,
      pr_number: m.prNumber,
      pr_url: m.prUrl,
      reviewed_head_sha: "",
      state: "merged",
      merge_sha: m.mergeSha,
      method: m.how,
      sentence: "",
      ...takeOut,
      author_agent: this.deps.agentId,
      author_human: this.deps.humanId,
    });
  }

  /**
   * One Inbox notice for a take-out that conflicted (kept once per task while it is open). Its
   * card keeps the task's title and the files: `request-words.ts` titles it by the task and says
   * the rest in one sentence (`takeOutNoticeCard`); the `why` is the whole sentence for readers
   * that show one line.
   */
  private async notice(task: TaskRow, sentence: string, files: readonly string[]): Promise<void> {
    const key = `${TAKE_OUT_NOTICE_PREFIX}${task.id}`;
    const open = await this.deps.store.humanRequest.list(
      { status: "open", project_id: task.project_id } as never,
      { limit: 500 },
    );
    if (open.some((r) => (r.change_card as { key?: unknown } | null)?.key === key)) return;
    await this.deps.store.humanRequest.insert({
      human_id: this.deps.humanId,
      project_id: task.project_id,
      task_id: null,
      session_id: null,
      kind: "info",
      why: sentence,
      steps: [],
      options: [],
      blocking: false,
      risk: "low",
      change_card: { key, task_id: task.id, task_title: task.title, files: [...files] },
      author_agent: this.deps.agentId,
    });
  }
}
