/**
 * Domain operations that touch git and the store together: repo creation, commits through the
 * API, ref changes (from the API or from a push over HTTP) with their push/create/delete
 * events, pull request mergeability and merges. Routes and the admin API both call these so
 * the two paths behave identically.
 */
import { rm } from "node:fs/promises";
import { type Clock, join } from "@forerunner/platform";
import { BareRepo, type CommitAuthor, type DiffFile, type MergeMethod, ZERO_SHA } from "./git.ts";
import { HttpError, validationFailed } from "./http.ts";
import {
  DEFAULT_LABELS,
  type HostStore,
  type IssueRecord,
  type Json,
  type LabelRecord,
  type PullData,
  type RepoRecord,
} from "./store.ts";
import type { CreateRepoInput } from "./types.ts";

export const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export const LOGIN_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type RefSnapshot = Map<string, string>;

export function isPull(issue: IssueRecord): issue is IssueRecord & { pull: PullData } {
  return issue.pull !== null;
}

export class RepoOps {
  constructor(
    private readonly store: HostStore,
    private readonly clock: Clock,
    private readonly rootDir: string,
  ) {}

  authorFor(login: string): CommitAuthor {
    const u = this.store.user(login);
    return {
      name: u?.name || login,
      email: u?.email || `${login}@users.noreply.fake-git-host`,
    };
  }

  // ---- repositories ------------------------------------------------------------------------

  async createRepo(input: CreateRepoInput & { creator?: string }): Promise<RepoRecord> {
    const owner = this.store.user(input.owner);
    if (!owner) throw new HttpError(404, "Not Found");
    if (!REPO_NAME.test(input.name) || input.name === "." || input.name === "..") {
      throw validationFailed([{ resource: "Repository", field: "name", code: "invalid" }]);
    }
    if (this.store.repo(owner.login, input.name)) {
      throw validationFailed(
        [
          {
            resource: "Repository",
            field: "name",
            code: "custom",
            message: "name already exists on this account",
          },
        ],
        "Repository creation failed.",
      );
    }
    const defaultBranch = input.defaultBranch ?? "main";
    const dir = join(this.rootDir, owner.login, `${input.name}.git`);
    const git = await BareRepo.init(dir, defaultBranch);
    const now = this.clock.nowIso();
    const repo: RepoRecord = {
      id: this.store.nextId(),
      owner: owner.login,
      name: input.name,
      fullName: `${owner.login}/${input.name}`,
      private: input.private ?? false,
      defaultBranch,
      description: input.description ?? "",
      dir,
      git,
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      nextNumber: 1,
      nextProjectNumber: 1,
      issues: new Map(),
      comments: new Map(),
      labels: new Map(),
      releases: new Map(),
      checkRuns: new Map(),
      statuses: [],
      hooks: new Map(),
      projects: [],
      collaborators: new Set(),
    };
    for (const [name, color, description] of DEFAULT_LABELS) {
      const l: LabelRecord = { id: this.store.nextId(), name, color, description, isDefault: true };
      repo.labels.set(name.toLowerCase(), l);
    }
    this.store.repos.set(repo.fullName.toLowerCase(), repo);
    if (input.initialFiles && Object.keys(input.initialFiles).length > 0) {
      await this.commitFiles(
        repo,
        defaultBranch,
        input.initialFiles,
        "Initial commit",
        input.creator ?? owner.login,
      );
    }
    return repo;
  }

  async deleteRepo(repo: RepoRecord): Promise<void> {
    this.store.repos.delete(repo.fullName.toLowerCase());
    for (const p of repo.projects) {
      this.store.projects.delete(p.id);
      for (const col of p.columns) {
        this.store.columns.delete(col.id);
        for (const card of col.cards) this.store.cards.delete(card.id);
      }
    }
    for (const run of repo.checkRuns.keys()) this.store.checkRunsById.delete(run);
    for (const rel of repo.releases.values())
      for (const a of rel.assets.keys()) this.store.assetsById.delete(a);
    await rm(repo.dir, { recursive: true, force: true });
  }

  // ---- refs and commits ----------------------------------------------------------------------

  async refSnapshot(repo: RepoRecord): Promise<RefSnapshot> {
    return new Map((await repo.git.refs()).map((r) => [r.ref, r.sha]));
  }

  /**
   * Commit `files` on `branch` (created from the default branch when missing) and emit the
   * push event. Returns the new commit sha.
   */
  async commitFiles(
    repo: RepoRecord,
    branch: string,
    files: Record<string, string | Uint8Array | null>,
    message: string,
    login: string,
    opts: { expectParent?: string | null } = {},
  ): Promise<string> {
    const ref = `refs/heads/${branch}`;
    const before = await this.refSnapshot(repo);
    let parent = before.get(ref) ?? null;
    if (parent === null && branch !== repo.defaultBranch) {
      parent = before.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (opts.expectParent !== undefined && opts.expectParent !== parent) {
      throw new HttpError(409, `${branch} does not match ${opts.expectParent ?? "(none)"}`);
    }
    const author = this.authorFor(login);
    const sha = await repo.git.commitFiles({
      parent,
      files,
      message,
      author,
      date: this.clock.nowIso(),
    });
    await repo.git.updateRef(ref, sha, before.get(ref) ?? null);
    const after = new Map(before);
    after.set(ref, sha);
    await this.applyRefChanges(repo, before, after, login);
    return sha;
  }

  /** Create, move or delete a ref through the API; `sha` null deletes. */
  async setRef(
    repo: RepoRecord,
    ref: string,
    sha: string | null,
    login: string,
    opts: { force?: boolean; mustExist?: boolean; mustNotExist?: boolean } = {},
  ): Promise<void> {
    if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/")) {
      throw validationFailed(
        [{ resource: "Reference", field: "ref", code: "invalid" }],
        "Reference name is not valid",
      );
    }
    const before = await this.refSnapshot(repo);
    const current = before.get(ref) ?? null;
    if (opts.mustExist && current === null) throw new HttpError(422, "Reference does not exist");
    if (opts.mustNotExist && current !== null) throw new HttpError(422, "Reference already exists");
    if (sha === null) {
      if (current === null) throw new HttpError(422, "Reference does not exist");
      await repo.git.deleteRef(ref);
    } else {
      const resolved = await repo.git.revParse(sha);
      if (!resolved) throw new HttpError(422, "Object does not exist");
      if (current && !opts.force && !(await repo.git.isAncestor(current, resolved))) {
        throw new HttpError(422, "Update is not a fast forward");
      }
      await repo.git.updateRef(ref, resolved, current);
    }
    const after = new Map(before);
    if (sha === null) after.delete(ref);
    else after.set(ref, (await repo.git.revParse(ref)) ?? "");
    await this.applyRefChanges(repo, before, after, login);
  }

  /** Emit push/create/delete events for every ref that differs and sync PRs on those branches. */
  async applyRefChanges(
    repo: RepoRecord,
    before: RefSnapshot,
    after: RefSnapshot,
    pusher: string,
  ): Promise<void> {
    const refs = new Set([...before.keys(), ...after.keys()]);
    const pusherAuthor = this.authorFor(pusher);
    for (const ref of refs) {
      const b = before.get(ref) ?? ZERO_SHA;
      const a = after.get(ref) ?? ZERO_SHA;
      if (b === a) continue;
      const isBranch = ref.startsWith("refs/heads/");
      const isTag = ref.startsWith("refs/tags/");
      if (!isBranch && !isTag) continue;
      const name = ref.replace(/^refs\/(heads|tags)\//, "");
      const created = b === ZERO_SHA;
      const deleted = a === ZERO_SHA;
      const forced = !created && !deleted && !(await repo.git.isAncestor(b, a));
      // Like GitHub: commits new to the repository (for a new branch, those not reachable
      // from any ref that existed before the push), oldest first, capped at 20.
      const exclusions = created
        ? [...new Set(before.values())].map((sha) => `^${sha}`)
        : [`^${b}`];
      const infos = deleted ? [] : await repo.git.log([a, ...exclusions], 20);
      const commits: Json[] = [];
      for (const c of infos.reverse()) {
        const parent = c.parents[0];
        const files = parent ? await repo.git.diffFiles(parent, c.sha, false) : [];
        commits.push(this.store.pushCommitJson(repo, c, files));
      }
      const headInfo = deleted ? null : await repo.git.commit(a);
      const headCommit = headInfo
        ? this.store.pushCommitJson(
            repo,
            headInfo,
            headInfo.parents[0] ? await repo.git.diffFiles(headInfo.parents[0], a, false) : [],
          )
        : null;
      repo.pushedAt = this.clock.nowIso();
      repo.updatedAt = repo.pushedAt;
      this.store.emit(
        repo,
        "push",
        null,
        {
          ref,
          before: b,
          after: a,
          created,
          deleted,
          forced,
          base_ref: null,
          compare: `${this.store.baseUrl}/${repo.fullName}/compare/${b.slice(0, 12)}...${a.slice(0, 12)}`,
          commits,
          head_commit: headCommit,
          pusher: { name: pusher, email: pusherAuthor.email },
        },
        pusher,
      );
      if (created || deleted) {
        this.store.emit(
          repo,
          created ? "create" : "delete",
          null,
          {
            ref: name,
            ref_type: isBranch ? "branch" : "tag",
            master_branch: repo.defaultBranch,
            description: repo.description,
            pusher_type: "user",
          },
          pusher,
        );
      }
      if (isBranch) await this.syncPullsForBranch(repo, name, b, a, deleted, pusher);
    }
  }

  private async syncPullsForBranch(
    repo: RepoRecord,
    branch: string,
    before: string,
    after: string,
    deleted: boolean,
    actor: string,
  ): Promise<void> {
    for (const issue of repo.issues.values()) {
      if (!isPull(issue) || issue.state !== "open") continue;
      const p = issue.pull;
      if (p.headRef === branch) {
        if (deleted) {
          issue.state = "closed";
          issue.closedAt = this.clock.nowIso();
          issue.updatedAt = issue.closedAt;
          p.mergeable = null;
          p.mergeableState = "unknown";
          this.store.emit(repo, "pull_request", "closed", this.pullPayload(repo, issue), actor);
          continue;
        }
        p.headSha = after;
        issue.updatedAt = this.clock.nowIso();
        await this.computeMergeability(repo, issue);
        this.store.emit(
          repo,
          "pull_request",
          "synchronize",
          { ...this.pullPayload(repo, issue), before, after },
          actor,
        );
      } else if (p.baseRef === branch) {
        p.baseSha = deleted ? p.baseSha : after;
        await this.computeMergeability(repo, issue);
      }
    }
  }

  // ---- pull requests -------------------------------------------------------------------------

  pullPayload(repo: RepoRecord, issue: IssueRecord & { pull: PullData }): Json {
    return { number: issue.number, pull_request: this.store.pullJson(repo, issue) };
  }

  /** Refresh head/base shas from the branches and recompute mergeability. */
  async computeMergeability(
    repo: RepoRecord,
    issue: IssueRecord & { pull: PullData },
  ): Promise<void> {
    const p = issue.pull;
    if (issue.state !== "open") {
      p.mergeable = null;
      p.mergeableState = "unknown";
      return;
    }
    const head = await repo.git.revParse(`refs/heads/${p.headRef}`);
    const base = await repo.git.revParse(`refs/heads/${p.baseRef}`);
    if (head) p.headSha = head;
    if (base) p.baseSha = base;
    if (!head || !base) {
      p.mergeable = null;
      p.mergeableState = "unknown";
      return;
    }
    const res = await repo.git.mergeTree(base, head);
    p.mergeable = res.ok;
    p.mergeableState = res.ok ? "clean" : "dirty";
  }

  async pullStats(
    repo: RepoRecord,
    issue: IssueRecord & { pull: PullData },
  ): Promise<{ commits: number; files: DiffFile[] }> {
    const p = issue.pull;
    const head = p.merged
      ? p.headSha
      : ((await repo.git.revParse(`refs/heads/${p.headRef}`)) ?? p.headSha);
    const headOk = await repo.git.revParse(head);
    const baseOk = await repo.git.revParse(p.baseSha);
    if (!headOk || !baseOk) return { commits: 0, files: [] };
    const commits = (await repo.git.log([headOk, `^${baseOk}`], 1000)).length;
    const files = await repo.git.diffFiles(baseOk, headOk);
    return { commits, files };
  }

  async openPull(
    repo: RepoRecord,
    input: {
      title: string;
      body: string;
      head: string;
      base: string;
      draft: boolean;
      user: string;
    },
  ): Promise<IssueRecord & { pull: PullData }> {
    const headRef = input.head.includes(":") ? (input.head.split(":")[1] ?? "") : input.head;
    const headSha = await repo.git.revParse(`refs/heads/${headRef}`);
    const baseSha = await repo.git.revParse(`refs/heads/${input.base}`);
    const errors: Array<{ resource: string; field: string; code: string; message?: string }> = [];
    if (!headSha) errors.push({ resource: "PullRequest", field: "head", code: "invalid" });
    if (!baseSha) errors.push({ resource: "PullRequest", field: "base", code: "invalid" });
    if (errors.length > 0) throw validationFailed(errors);
    if (headRef === input.base) {
      throw validationFailed([
        {
          resource: "PullRequest",
          field: "head",
          code: "invalid",
          message: "head and base must be different branches",
        },
      ]);
    }
    for (const other of repo.issues.values()) {
      if (
        other.pull &&
        other.state === "open" &&
        other.pull.headRef === headRef &&
        other.pull.baseRef === input.base
      ) {
        throw validationFailed([
          {
            resource: "PullRequest",
            code: "custom",
            field: "head",
            message: `A pull request already exists for ${repo.owner}:${headRef}.`,
          },
        ]);
      }
    }
    if (headSha && baseSha && (await repo.git.isAncestor(headSha, baseSha))) {
      throw validationFailed([
        {
          resource: "PullRequest",
          field: "head",
          code: "custom",
          message: `No commits between ${input.base} and ${headRef}`,
        },
      ]);
    }
    const now = this.clock.nowIso();
    const issue: IssueRecord & { pull: PullData } = {
      id: this.store.nextId(),
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: "open",
      stateReason: null,
      user: input.user,
      labels: [],
      assignees: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      pull: {
        headRef,
        headSha: headSha ?? "",
        baseRef: input.base,
        baseSha: baseSha ?? "",
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeCommitSha: null,
        mergeable: null,
        mergeableState: "unknown",
        draft: input.draft,
        reviews: [],
        reviewComments: [],
      },
    };
    repo.issues.set(issue.number, issue);
    await this.computeMergeability(repo, issue);
    this.store.emit(repo, "pull_request", "opened", this.pullPayload(repo, issue), input.user);
    return issue;
  }

  async mergePull(
    repo: RepoRecord,
    issue: IssueRecord & { pull: PullData },
    input: { method: MergeMethod; title?: string; message?: string; sha?: string; user: string },
  ): Promise<{ sha: string }> {
    const p = issue.pull;
    if (issue.state !== "open" || p.merged)
      throw new HttpError(405, "Pull Request is not mergeable");
    await this.computeMergeability(repo, issue);
    if (input.sha && input.sha !== p.headSha) {
      throw new HttpError(409, "Head branch was modified. Review and try the merge again.");
    }
    if (!p.mergeable) throw new HttpError(405, "Pull Request is not mergeable");
    const title =
      input.title ??
      (input.method === "squash"
        ? `${issue.title} (#${issue.number})`
        : `Merge pull request #${issue.number} from ${repo.owner}/${p.headRef}`);
    const body = input.message ?? (input.method === "squash" ? issue.body : issue.title);
    const message = body ? `${title}\n\n${body}` : title;
    const committer = this.authorFor(input.user);
    const author = input.method === "squash" ? this.authorFor(issue.user) : committer;
    const before = await this.refSnapshot(repo);
    const sha = await repo.git.mergeInto(
      input.method,
      p.baseRef,
      p.headSha,
      message,
      committer,
      this.clock.nowIso(),
      author,
    );
    if (!sha) throw new HttpError(405, "Pull Request is not mergeable");
    const now = this.clock.nowIso();
    p.merged = true;
    p.mergedAt = now;
    p.mergedBy = input.user;
    p.mergeCommitSha = sha;
    p.baseSha = sha;
    p.mergeable = null;
    p.mergeableState = "unknown";
    issue.state = "closed";
    issue.closedAt = now;
    issue.updatedAt = now;
    this.store.emit(repo, "pull_request", "closed", this.pullPayload(repo, issue), input.user);
    const after = new Map(before);
    after.set(`refs/heads/${p.baseRef}`, sha);
    await this.applyRefChanges(repo, before, after, input.user);
    return { sha };
  }

  /** Merge the base branch into the PR head ("Update branch"). */
  async updatePullBranch(
    repo: RepoRecord,
    issue: IssueRecord & { pull: PullData },
    user: string,
  ): Promise<string | null> {
    const p = issue.pull;
    await this.computeMergeability(repo, issue);
    if (await repo.git.isAncestor(p.baseSha, p.headSha)) return p.headSha;
    const tip = await repo.git.mergeInto(
      "merge",
      p.headRef,
      p.baseSha,
      `Merge branch '${p.baseRef}' into ${p.headRef}`,
      this.authorFor(user),
      this.clock.nowIso(),
    );
    if (!tip) return null;
    const before = new Map([[`refs/heads/${p.headRef}`, p.headSha]]);
    const after = new Map([[`refs/heads/${p.headRef}`, tip]]);
    await this.applyRefChanges(repo, before, after, user);
    return tip;
  }

  // ---- issues ------------------------------------------------------------------------------

  createIssue(
    repo: RepoRecord,
    input: { title: string; body: string; labels: string[]; assignees: string[]; user: string },
  ): IssueRecord {
    const now = this.clock.nowIso();
    const issue: IssueRecord = {
      id: this.store.nextId(),
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: "open",
      stateReason: null,
      user: input.user,
      labels: this.ensureLabels(repo, input.labels),
      assignees: input.assignees,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      pull: null,
    };
    repo.issues.set(issue.number, issue);
    this.store.emit(
      repo,
      "issues",
      "opened",
      { issue: this.store.issueJson(repo, issue) },
      input.user,
    );
    return issue;
  }

  /** Create missing labels on the fly (GitHub does the same when labels are set by name). */
  ensureLabels(repo: RepoRecord, names: string[]): string[] {
    const out: string[] = [];
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      let label = repo.labels.get(name.toLowerCase());
      if (!label) {
        label = {
          id: this.store.nextId(),
          name,
          color: "ededed",
          description: "",
          isDefault: false,
        };
        repo.labels.set(name.toLowerCase(), label);
      }
      if (!out.some((n) => n.toLowerCase() === label?.name.toLowerCase())) out.push(label.name);
    }
    return out;
  }
}
