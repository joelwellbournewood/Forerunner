import { ForerunnerError } from "@forerunner/platform";
import {
  type BranchRules,
  type CheckRunInfo,
  type CommentInfo,
  type CommitStatusInfo,
  type FileContent,
  FORERUNNER_TASK_ID_FIELD,
  type GitHost,
  type IssueInfo,
  type MergeMethod,
  markAgentText,
  type ProjectFieldInfo,
  type ProjectFieldSpec,
  type ProjectInfo,
  type ProjectItemFields,
  type ProjectItemInfo,
  type ProjectItemInput,
  type PullRequestInfo,
  type ReleaseInfo,
  type RepoInfo,
  type RepoRef,
  type ReviewCommentInfo,
  type ReviewInfo,
  type UpsertItemResult,
} from "./types.ts";

/**
 * In-memory git host for unit tests of callers (no HTTP, no git). Branch and file state is a
 * plain map; mergeability is a flag tests can flip. The fake HTTP host in testenv covers the
 * wire protocol; this covers the contract.
 */
interface Repo extends RepoInfo {
  files: Map<string, Map<string, string>>; // branch -> path -> content
  prs: PullRequestInfo[];
  issues: IssueInfo[];
  comments: Map<number, CommentInfo[]>;
  reviews: Map<number, ReviewInfo[]>;
  reviewComments: Map<number, ReviewCommentInfo[]>;
  checks: Map<string, CheckRunInfo[]>;
  statuses: Map<string, CommitStatusInfo[]>;
  releases: ReleaseInfo[];
  nextNumber: number;
  allowMergeCommit: boolean;
  rules: Map<string, Partial<BranchRules>>;
}

/** GitHub's owner and repository names are case-insensitive; the stand-in agrees (C2-left-12). */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface MemoryProject extends ProjectInfo {
  owner: string;
  fields: ProjectFieldInfo[];
  items: MemoryItem[];
}

interface MemoryItem extends ProjectItemInfo {
  projectId: string;
}

/**
 * One write a login made on the host (w8-two-homes): what the two-home harness reads to prove
 * that neither Forerunner wrote to the other's pull requests, marker, guide or comment.
 */
export interface MemoryHostWrite {
  /** The GitHub login of the view that wrote it. */
  login: string;
  op: string;
  /** "owner/name", or the project id for a Projects call. */
  repo: string;
  /** The pull request or issue it wrote to, when there is one. */
  number?: number;
  /** The branch, path or other detail of the write, when there is one. */
  detail?: string;
}

/** What every login's view of one host shares: one GitHub, seen by several accounts. */
interface MemoryHostWorld {
  repos: Map<string, Repo>;
  projects: Map<string, MemoryProject>;
  nextId: number;
  nextRepoId: number;
  mergeableByDefault: boolean;
  merges: { repo: string; number: number; method: MergeMethod; sha: string | null }[];
  projectCalls: { op: string; projectId?: string; detail?: string }[];
  writes: MemoryHostWrite[];
  now: () => string;
}

export class MemoryGitHost implements GitHost {
  readonly kind = "github" as const;
  readonly baseUrl = "memory://";
  readonly login: string;
  /**
   * The host's state, shared by every view `asLogin` makes (w8-two-homes, W8-homes-2): two
   * Forerunners with two GitHub accounts meet on one GitHub, and each write carries the login of
   * the view that made it.
   */
  private readonly world: MemoryHostWorld;

  private get repos(): Map<string, Repo> {
    return this.world.repos;
  }
  private get projects(): Map<string, MemoryProject> {
    return this.world.projects;
  }
  private get nextId(): number {
    return this.world.nextId;
  }
  private set nextId(n: number) {
    this.world.nextId = n;
  }
  /** GitHub's numeric repository ids, given in creation order (`RepoInfo.id`). */
  private get nextRepoId(): number {
    return this.world.nextRepoId;
  }
  private set nextRepoId(n: number) {
    this.world.nextRepoId = n;
  }
  get mergeableByDefault(): boolean {
    return this.world.mergeableByDefault;
  }
  set mergeableByDefault(v: boolean) {
    this.world.mergeableByDefault = v;
  }
  /** Every merge made, in order, with its method (tests assert merge commits only). */
  get merges(): MemoryHostWorld["merges"] {
    return this.world.merges;
  }
  /** Every project call, in order (tests assert how many outward calls a sync made). */
  get projectCalls(): MemoryHostWorld["projectCalls"] {
    return this.world.projectCalls;
  }
  /** Every write any view made, in order, with the view's login (w8-two-homes). */
  get writes(): readonly MemoryHostWrite[] {
    return this.world.writes;
  }

  /**
   * The time a pull request is stamped with when it is opened or changed (`updatedAt`); tests
   * set it to say when a project was last worked on (d1109-onerepo-link). Shared by every view.
   */
  get now(): () => string {
    return this.world.now;
  }
  set now(fn: () => string) {
    this.world.now = fn;
  }

  constructor(login = "alice", sharedWith?: MemoryGitHost) {
    this.login = login;
    this.world = sharedWith
      ? sharedWith.world
      : {
          repos: new Map(),
          projects: new Map(),
          nextId: 1,
          nextRepoId: 1001,
          mergeableByDefault: true,
          merges: [],
          projectCalls: [],
          writes: [],
          now: () => new Date().toISOString(),
        };
  }

  /**
   * The same GitHub seen by another account (w8-two-homes, W8-homes-2): one shared state, and
   * `whoAmI` and the author of every write are `login`'s. Two composed homes each get their own
   * view, so a pull request or comment Bob's Forerunner writes carries bob, never alice.
   */
  asLogin(login: string): MemoryGitHost {
    return new MemoryGitHost(login, this);
  }

  /** The writes `login` made, in order (the harness's `writesBy`). */
  writesBy(login: string): MemoryHostWrite[] {
    return this.world.writes.filter((w) => w.login === login);
  }

  private wrote(op: string, repo: RepoRef | string, extra: Partial<MemoryHostWrite> = {}): void {
    const name = typeof repo === "string" ? repo : this.key(repo);
    this.world.writes.push({ login: this.login, op, repo: name, ...extra });
  }

  /**
   * Opens a pull request as another GitHub account would (tests: a project of another
   * Forerunner on the same repository), through that account's view. `updatedAt` defaults to
   * `now()`.
   */
  async openPullRequestAs(
    repo: RepoRef,
    author: string,
    opts: {
      title: string;
      body: string;
      head: string;
      base?: string;
      state?: "open" | "closed";
      merged?: boolean;
      updatedAt?: string;
    },
  ): Promise<PullRequestInfo> {
    const r = this.repo(repo);
    const pr = await this.asLogin(author).createPullRequest(repo, {
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base ?? r.defaultBranch,
    });
    if (opts.state === "closed" || opts.merged) pr.state = "closed";
    if (opts.merged) pr.merged = true;
    if (opts.updatedAt) pr.updatedAt = opts.updatedAt;
    return pr;
  }

  private key(r: RepoRef): string {
    return `${r.owner}/${r.name}`;
  }

  /** Where a repository is kept: GitHub reads owner and name whatever their case (C2-left-12). */
  private slot(r: RepoRef): string {
    return this.key(r).toLowerCase();
  }

  private repo(r: RepoRef): Repo {
    const repo = this.repos.get(this.slot(r));
    if (!repo) throw new ForerunnerError("not_found", `repo ${this.key(r)} not found`);
    return repo;
  }

  async whoAmI(): Promise<{ login: string }> {
    return { login: this.login };
  }

  async getRepo(repo: RepoRef): Promise<RepoInfo> {
    const r = this.repo(repo);
    return {
      owner: r.owner,
      name: r.name,
      fullName: r.fullName,
      defaultBranch: r.defaultBranch,
      private: r.private,
      htmlUrl: r.htmlUrl,
      cloneUrl: r.cloneUrl,
      permissions: r.permissions,
      allowMergeCommit: r.allowMergeCommit,
      ...(r.id !== undefined ? { id: r.id } : {}),
    };
  }

  async listRepos(opts: { org?: string; user?: string } = {}): Promise<RepoInfo[]> {
    return [...this.repos.values()]
      .filter(
        (r) =>
          (!opts.org || sameName(r.owner, opts.org)) &&
          (!opts.user || sameName(r.owner, opts.user)),
      )
      .map((r) => ({
        owner: r.owner,
        name: r.name,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        private: r.private,
        htmlUrl: r.htmlUrl,
        cloneUrl: r.cloneUrl,
      }));
  }

  async createRepo(opts: {
    owner?: string;
    name: string;
    private: boolean;
    description?: string;
    autoInit?: boolean;
    cloneUrl?: string;
  }): Promise<RepoInfo> {
    const owner = opts.owner ?? this.login;
    const fullName = `${owner}/${opts.name}`;
    const repo: Repo = {
      owner,
      name: opts.name,
      fullName,
      defaultBranch: "main",
      private: opts.private,
      htmlUrl: `memory://${fullName}`,
      cloneUrl: opts.cloneUrl ?? `memory://${fullName}.git`,
      permissions: { pull: true, push: true, admin: false },
      files: new Map([["main", new Map([["README.md", `# ${opts.name}\n`]])]]),
      prs: [],
      issues: [],
      comments: new Map(),
      reviews: new Map(),
      reviewComments: new Map(),
      checks: new Map(),
      statuses: new Map(),
      releases: [],
      nextNumber: 1,
      allowMergeCommit: true,
      rules: new Map(),
      id: this.nextRepoId++,
    };
    this.repos.set(fullName.toLowerCase(), repo);
    this.wrote("createRepo", fullName);
    return this.getRepo(repo);
  }

  async listBranches(repo: RepoRef): Promise<{ name: string; sha: string }[]> {
    return [...this.repo(repo).files.keys()].map((name) => ({ name, sha: `sha-${name}` }));
  }

  async getFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent | null> {
    const r = this.repo(repo);
    const content = r.files.get(ref ?? r.defaultBranch)?.get(path);
    return content === undefined ? null : { path, sha: `sha-${path}`, content, encoding: "utf8" };
  }

  async putFile(
    repo: RepoRef,
    opts: { path: string; content: string; message: string; branch: string; sha?: string },
  ): Promise<{ sha: string }> {
    const r = this.repo(repo);
    if (!r.files.has(opts.branch)) r.files.set(opts.branch, new Map(r.files.get(r.defaultBranch)));
    r.files.get(opts.branch)?.set(opts.path, opts.content);
    this.wrote("putFile", repo, { detail: `${opts.branch}:${opts.path}` });
    return { sha: `sha-${opts.branch}-${opts.path}` };
  }

  async createPullRequest(
    repo: RepoRef,
    opts: { title: string; body: string; head: string; base: string; draft?: boolean },
  ): Promise<PullRequestInfo> {
    const r = this.repo(repo);
    if (r.prs.some((p) => p.state === "open" && p.head.ref === opts.head))
      throw new ForerunnerError("validation", `a pull request for ${opts.head} already exists`);
    const pr: PullRequestInfo = {
      number: r.nextNumber++,
      title: opts.title,
      body: opts.body,
      state: "open",
      merged: false,
      mergeable: this.mergeableByDefault,
      head: { ref: opts.head, sha: `sha-${opts.head}` },
      base: { ref: opts.base, sha: `sha-${opts.base}` },
      htmlUrl: `memory://${r.fullName}/pull/${r.nextNumber - 1}`,
      draft: opts.draft ?? false,
      updatedAt: this.now(),
      authorLogin: this.login,
    };
    r.prs.push(pr);
    this.wrote("createPullRequest", repo, { number: pr.number, detail: opts.head });
    return pr;
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo> {
    const pr = this.repo(repo).prs.find((p) => p.number === number);
    if (!pr) throw new ForerunnerError("not_found", `pull request ${number} not found`);
    return pr;
  }

  async updatePullRequest(
    repo: RepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed" },
  ): Promise<PullRequestInfo> {
    const pr = await this.getPullRequest(repo, number);
    if (patch.title !== undefined) pr.title = patch.title;
    if (patch.body !== undefined) pr.body = patch.body;
    if (patch.state === "closed" && pr.state === "open") pr.state = "closed";
    else if (patch.state === "open" && pr.state === "closed" && !pr.merged) pr.state = "open";
    pr.updatedAt = this.now();
    this.wrote("updatePullRequest", repo, {
      number,
      detail: Object.keys(patch).sort().join(","),
    });
    return pr;
  }

  async getBranchHead(repo: RepoRef, branch: string): Promise<string | null> {
    return this.repo(repo).files.has(branch) ? `sha-${branch}` : null;
  }

  async listPullRequests(
    repo: RepoRef,
    opts: { state?: "open" | "closed" | "all"; head?: string; sort?: "updated" } = {},
  ): Promise<PullRequestInfo[]> {
    const list = this.repo(repo)
      .prs.filter((p) => (opts.state ?? "open") === "all" || p.state === (opts.state ?? "open"))
      .filter((p) => !opts.head || p.head.ref === opts.head.replace(/^[^:]+:/, ""));
    // As GitHub's `sort=updated&direction=desc`: the latest first, one page of 100.
    return opts.sort === "updated"
      ? [...list]
          .sort(
            (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || b.number - a.number,
          )
          .slice(0, 100)
      : list;
  }

  async mergePullRequest(
    repo: RepoRef,
    number: number,
    opts: { sha?: string; method?: MergeMethod } = {},
  ): Promise<{ merged: boolean; sha: string | null; message: string }> {
    const r = this.repo(repo);
    const pr = await this.getPullRequest(repo, number);
    if (pr.state !== "open") return { merged: false, sha: null, message: "already closed" };
    if (opts.sha && opts.sha !== pr.head.sha)
      return {
        merged: false,
        sha: null,
        message: "Head branch was modified. Review and try the merge again.",
      };
    if (!pr.mergeable)
      return { merged: false, sha: null, message: "Pull Request is not mergeable" };
    // GitHub's default method is a merge commit, and a repository can turn it off.
    const method = opts.method ?? "merge";
    if (method === "merge" && !r.allowMergeCommit)
      return {
        merged: false,
        sha: null,
        message: "Merge commits are not allowed on this repository.",
      };
    pr.state = "closed";
    pr.merged = true;
    pr.mergeCommitSha = `${method}-${number}`;
    this.merges.push({ repo: this.key(repo), number, method, sha: opts.sha ?? null });
    this.wrote("mergePullRequest", repo, { number, detail: method });
    const head = r.files.get(pr.head.ref);
    if (head)
      r.files.set(pr.base.ref, new Map([...(r.files.get(pr.base.ref) ?? new Map()), ...head]));
    return { merged: true, sha: pr.mergeCommitSha, message: "merged" };
  }

  async commentOnPullRequest(repo: RepoRef, number: number, body: string): Promise<CommentInfo> {
    this.wrote("commentOnPullRequest", repo, { number });
    return this.comment(repo, number, body);
  }

  /** A comment on a pull request or an issue (they share numbers), as this view's login. */
  private comment(repo: RepoRef, number: number, body: string): CommentInfo {
    const r = this.repo(repo);
    const c: CommentInfo = {
      id: this.nextId++,
      body: markAgentText(body),
      author: this.login,
      createdAt: new Date(0).toISOString(),
      htmlUrl: `memory://${r.fullName}/c/${this.nextId - 1}`,
    };
    r.comments.set(number, [...(r.comments.get(number) ?? []), c]);
    return c;
  }

  async listPullRequestComments(
    repo: RepoRef,
    number: number,
    opts: { since?: string } = {},
  ): Promise<CommentInfo[]> {
    const all = this.repo(repo).comments.get(number) ?? [];
    const since = opts.since;
    return since ? all.filter((c) => c.createdAt >= since) : all;
  }

  async listPullRequestReviews(repo: RepoRef, number: number): Promise<ReviewInfo[]> {
    return this.repo(repo).reviews.get(number) ?? [];
  }

  async listPullRequestReviewComments(
    repo: RepoRef,
    number: number,
    opts: { since?: string } = {},
  ): Promise<ReviewCommentInfo[]> {
    const all = this.repo(repo).reviewComments.get(number) ?? [];
    const since = opts.since;
    return since ? all.filter((c) => c.createdAt >= since) : all;
  }

  /** Test seam: a review line comment written by someone (the memory host has no other way). */
  addReviewComment(repo: RepoRef, number: number, c: Omit<ReviewCommentInfo, "id">): number {
    const r = this.repo(repo);
    const id = this.nextId++;
    r.reviewComments.set(number, [...(r.reviewComments.get(number) ?? []), { id, ...c }]);
    return id;
  }

  async reviewPullRequest(
    repo: RepoRef,
    number: number,
    opts: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
  ): Promise<{ id: number }> {
    const r = this.repo(repo);
    const id = this.nextId++;
    const state = (
      { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" } as const
    )[opts.event];
    const review: ReviewInfo = {
      id,
      body: markAgentText(opts.body),
      author: this.login,
      state,
      submittedAt: new Date(0).toISOString(),
      htmlUrl: `memory://${r.fullName}/r/${id}`,
    };
    r.reviews.set(number, [...(r.reviews.get(number) ?? []), review]);
    this.wrote("reviewPullRequest", repo, { number, detail: opts.event });
    return { id };
  }

  async createIssue(
    repo: RepoRef,
    opts: { title: string; body: string; labels?: string[] },
  ): Promise<IssueInfo> {
    const r = this.repo(repo);
    const issue: IssueInfo = {
      number: r.nextNumber++,
      title: opts.title,
      body: opts.body,
      state: "open",
      labels: opts.labels ?? [],
      htmlUrl: `memory://${r.fullName}/issues/${r.nextNumber - 1}`,
    };
    r.issues.push(issue);
    this.wrote("createIssue", repo, { number: issue.number });
    return issue;
  }

  async updateIssue(
    repo: RepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] },
  ): Promise<IssueInfo> {
    const issue = this.repo(repo).issues.find((i) => i.number === number);
    if (!issue) throw new ForerunnerError("not_found", `issue ${number} not found`);
    Object.assign(issue, patch);
    this.wrote("updateIssue", repo, { number, detail: Object.keys(patch).sort().join(",") });
    return issue;
  }

  async listIssues(
    repo: RepoRef,
    opts: { state?: "open" | "closed" | "all"; labels?: string[] } = {},
  ): Promise<IssueInfo[]> {
    return this.repo(repo)
      .issues.filter((i) => (opts.state ?? "open") === "all" || i.state === (opts.state ?? "open"))
      .filter((i) => !opts.labels?.length || opts.labels.every((l) => i.labels.includes(l)));
  }

  async commentOnIssue(repo: RepoRef, number: number, body: string): Promise<CommentInfo> {
    this.wrote("commentOnIssue", repo, { number });
    return this.comment(repo, number, body);
  }

  async listCheckRuns(repo: RepoRef, ref: string): Promise<CheckRunInfo[]> {
    return this.repo(repo).checks.get(ref) ?? [];
  }

  setCheckRuns(repo: RepoRef, ref: string, runs: CheckRunInfo[]): void {
    this.repo(repo).checks.set(ref, runs);
  }

  async listCommitStatuses(repo: RepoRef, ref: string): Promise<CommitStatusInfo[]> {
    return this.repo(repo).statuses.get(ref) ?? [];
  }

  setCommitStatuses(repo: RepoRef, ref: string, statuses: CommitStatusInfo[]): void {
    this.repo(repo).statuses.set(ref, statuses);
  }

  async getBranchRules(repo: RepoRef, branch: string): Promise<BranchRules> {
    const set = this.repo(repo).rules.get(branch);
    return {
      requiredApprovals: 0,
      codeOwnerReview: false,
      upToDate: false,
      requiredChecks: [],
      allowedMethods: null,
      blockers: [],
      unreadable: false,
      ...set,
    };
  }

  /** Test seam: the rules a merge into `branch` must meet. */
  setBranchRules(repo: RepoRef, branch: string, rules: Partial<BranchRules>): void {
    this.repo(repo).rules.set(branch, rules);
  }

  /** Test seam: the repository's "Allow merge commits" setting. */
  setAllowMergeCommit(repo: RepoRef, allowed: boolean): void {
    this.repo(repo).allowMergeCommit = allowed;
  }

  async createRelease(
    repo: RepoRef,
    opts: { tagName: string; name: string; body: string; draft?: boolean; prerelease?: boolean },
  ): Promise<ReleaseInfo> {
    const r = this.repo(repo);
    const rel: ReleaseInfo = {
      id: this.nextId++,
      tagName: opts.tagName,
      name: opts.name,
      body: opts.body,
      draft: opts.draft ?? false,
      prerelease: opts.prerelease ?? false,
      htmlUrl: `memory://${r.fullName}/releases/${opts.tagName}`,
      assets: [],
    };
    r.releases.push(rel);
    this.wrote("createRelease", repo, { detail: opts.tagName });
    return rel;
  }

  async uploadReleaseAsset(
    repo: RepoRef,
    releaseId: number,
    name: string,
    data: Uint8Array,
  ): Promise<{ name: string; downloadUrl: string }> {
    const rel = this.repo(repo).releases.find((x) => x.id === releaseId);
    if (!rel) throw new ForerunnerError("not_found", `release ${releaseId} not found`);
    rel.assets.push({ name, size: data.byteLength, downloadUrl: `${rel.htmlUrl}/${name}` });
    this.wrote("uploadReleaseAsset", repo, { detail: name });
    return { name, downloadUrl: `${rel.htmlUrl}/${name}` };
  }

  async getLatestRelease(repo: RepoRef): Promise<ReleaseInfo | null> {
    const rels = this.repo(repo).releases.filter((x) => !x.draft);
    return rels.at(-1) ?? null;
  }

  async rateLimit(): Promise<{ limit: number; remaining: number; resetAt: string }> {
    return { limit: 5000, remaining: 5000, resetAt: new Date(0).toISOString() };
  }

  // ---- projects ------------------------------------------------------------------------------

  private project(id: string): MemoryProject {
    const p = this.projects.get(id);
    if (!p) throw new ForerunnerError("not_found", `project ${id} not found`);
    return p;
  }

  async ensureProject(owner: string, title: string): Promise<ProjectInfo> {
    this.projectCalls.push({ op: "ensureProject", detail: `${owner}:${title}` });
    this.wrote("ensureProject", owner, { detail: title });
    const existing = [...this.projects.values()].find(
      (p) => p.owner === owner && p.title === title && !p.closed,
    );
    if (existing) return info(existing);
    const id = `PVT_${this.nextId++}`;
    const p: MemoryProject = {
      id,
      number: this.projects.size + 1,
      title,
      url: `memory://${owner}/projects/${this.projects.size + 1}`,
      closed: false,
      owner,
      // Every new GitHub project carries a Status single-select with three options.
      fields: [
        { id: `${id}_title`, name: "Title", kind: "text", options: [] },
        {
          id: `${id}_status`,
          name: "Status",
          kind: "single_select",
          options: ["Todo", "In Progress", "Done"].map((n, i) => ({
            id: `${id}_status_${i}`,
            name: n,
          })),
        },
      ],
      items: [],
    };
    this.projects.set(id, p);
    return info(p);
  }

  async ensureFields(projectId: string, specs: ProjectFieldSpec[]): Promise<ProjectFieldInfo[]> {
    this.projectCalls.push({ op: "ensureFields", projectId });
    this.wrote("ensureFields", projectId);
    const p = this.project(projectId);
    for (const spec of specs) {
      let field = p.fields.find((f) => f.name.toLowerCase() === spec.name.toLowerCase());
      if (!field) {
        field = {
          id: `${projectId}_f${this.nextId++}`,
          name: spec.name,
          kind: spec.kind,
          options: [],
        };
        p.fields.push(field);
      } else if (field.kind !== spec.kind) {
        throw new ForerunnerError(
          "validation",
          `project field "${field.name}" exists with type ${field.kind}, expected ${spec.kind}`,
        );
      }
      if (spec.kind === "single_select") {
        for (const o of spec.options ?? []) {
          if (!field.options.some((x) => x.name.toLowerCase() === o.name.toLowerCase()))
            field.options.push({ id: `${field.id}_o${this.nextId++}`, name: o.name });
        }
      }
    }
    return p.fields.map((f) => ({ ...f, options: f.options.map((o) => ({ ...o })) }));
  }

  async listProjectItems(projectId: string): Promise<ProjectItemInfo[]> {
    this.projectCalls.push({ op: "listProjectItems", projectId });
    return this.project(projectId).items.map(itemInfo);
  }

  async findItem(projectId: string, forerunnerTaskId: string): Promise<ProjectItemInfo | null> {
    this.projectCalls.push({ op: "findItem", projectId, detail: forerunnerTaskId });
    const item = this.project(projectId).items.find((i) => i.forerunnerTaskId === forerunnerTaskId);
    return item ? itemInfo(item) : null;
  }

  async upsertItem(projectId: string, input: ProjectItemInput): Promise<UpsertItemResult> {
    this.projectCalls.push({ op: "upsertItem", projectId, detail: input.forerunnerTaskId });
    this.wrote("upsertItem", projectId, { detail: input.forerunnerTaskId });
    const p = this.project(projectId);
    let item = p.items.find((i) => i.forerunnerTaskId === input.forerunnerTaskId);
    let created = false;
    if (!item) {
      item = {
        id: `PVTI_${this.nextId++}`,
        projectId,
        forerunnerTaskId: input.forerunnerTaskId,
        title: input.title,
        body: input.body ?? "",
        archived: false,
        fields: {},
        kind: "draft",
      };
      p.items.push(item);
      created = true;
      await this.setItemFields(projectId, item.id, {
        [FORERUNNER_TASK_ID_FIELD]: input.forerunnerTaskId,
        ...(input.fields ?? {}),
      });
    } else {
      item.archived = false;
      if (item.kind === "draft") {
        item.title = input.title;
        item.body = input.body ?? "";
      }
      if (input.fields) await this.setItemFields(projectId, item.id, input.fields);
    }
    return { item: itemInfo(item), created };
  }

  async setItemFields(projectId: string, itemId: string, values: ProjectItemFields): Promise<void> {
    this.projectCalls.push({ op: "setItemFields", projectId, detail: itemId });
    this.wrote("setItemFields", projectId, { detail: itemId });
    const p = this.project(projectId);
    const item = p.items.find((i) => i.id === itemId);
    if (!item) throw new ForerunnerError("not_found", `project item ${itemId} not found`);
    for (const [name, value] of Object.entries(values)) {
      const field = p.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (!field) {
        throw new ForerunnerError("validation", `project field "${name}" does not exist`, {
          details: { projectId, field: name },
        });
      }
      if (value !== null && field.kind === "single_select") {
        const option = field.options.find((o) => o.name.toLowerCase() === value.toLowerCase());
        if (!option) {
          throw new ForerunnerError(
            "validation",
            `project field "${field.name}" has no option "${value}"`,
            { details: { projectId, field: field.name, value } },
          );
        }
        item.fields[field.name] = option.name;
      } else if (value !== null && field.kind !== "text") {
        throw new ForerunnerError(
          "validation",
          `project field "${field.name}" is ${field.kind}; the mirror writes text and single-select fields only`,
        );
      } else if (value === null) {
        // A cleared value is absent from a listing on GitHub too.
        delete item.fields[field.name];
      } else {
        item.fields[field.name] = value;
      }
      if (field.name === FORERUNNER_TASK_ID_FIELD) item.forerunnerTaskId = value;
    }
  }

  async archiveItem(projectId: string, itemId: string): Promise<void> {
    this.projectCalls.push({ op: "archiveItem", projectId, detail: itemId });
    this.wrote("archiveItem", projectId, { detail: itemId });
    const item = this.project(projectId).items.find((i) => i.id === itemId);
    if (!item) throw new ForerunnerError("not_found", `project item ${itemId} not found`);
    item.archived = true;
  }

  /**
   * Test helper: a change made "on the GitHub side" (a human editing the board). The mirror
   * must never copy it back into the store.
   */
  tamperItem(
    projectId: string,
    itemId: string,
    patch: Partial<Pick<ProjectItemInfo, "title" | "body" | "archived">> & {
      fields?: ProjectItemFields;
    },
  ): void {
    const item = this.project(projectId).items.find((i) => i.id === itemId);
    if (!item) throw new ForerunnerError("not_found", `project item ${itemId} not found`);
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.body !== undefined) item.body = patch.body;
    if (patch.archived !== undefined) item.archived = patch.archived;
    if (patch.fields) Object.assign(item.fields, patch.fields);
  }
}

function info(p: MemoryProject): ProjectInfo {
  return { id: p.id, number: p.number, title: p.title, url: p.url, closed: p.closed };
}

function itemInfo(i: MemoryItem): ProjectItemInfo {
  return {
    id: i.id,
    forerunnerTaskId: i.forerunnerTaskId,
    title: i.title,
    body: i.body,
    archived: i.archived,
    fields: { ...i.fields },
    kind: i.kind,
  };
}
