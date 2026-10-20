import { ForerunnerError } from "@forerunner/platform";
import type {
  CheckRunInfo,
  CommentInfo,
  FileContent,
  GitHost,
  IssueInfo,
  PullRequestInfo,
  ReleaseInfo,
  RepoInfo,
  RepoRef,
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
  checks: Map<string, CheckRunInfo[]>;
  releases: ReleaseInfo[];
  nextNumber: number;
}

export class MemoryGitHost implements GitHost {
  readonly kind = "github" as const;
  readonly baseUrl = "memory://";
  readonly login: string;
  private repos = new Map<string, Repo>();
  private nextId = 1;
  mergeableByDefault = true;

  constructor(login = "alice") {
    this.login = login;
  }

  private key(r: RepoRef): string {
    return `${r.owner}/${r.name}`;
  }

  private repo(r: RepoRef): Repo {
    const repo = this.repos.get(this.key(r));
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
    };
  }

  async listRepos(opts: { org?: string } = {}): Promise<RepoInfo[]> {
    return [...this.repos.values()]
      .filter((r) => !opts.org || r.owner === opts.org)
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
      checks: new Map(),
      releases: [],
      nextNumber: 1,
    };
    this.repos.set(fullName, repo);
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
    };
    r.prs.push(pr);
    return pr;
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo> {
    const pr = this.repo(repo).prs.find((p) => p.number === number);
    if (!pr) throw new ForerunnerError("not_found", `pull request ${number} not found`);
    return pr;
  }

  async listPullRequests(
    repo: RepoRef,
    opts: { state?: "open" | "closed" | "all"; head?: string } = {},
  ): Promise<PullRequestInfo[]> {
    return this.repo(repo)
      .prs.filter((p) => (opts.state ?? "open") === "all" || p.state === (opts.state ?? "open"))
      .filter((p) => !opts.head || p.head.ref === opts.head.replace(/^[^:]+:/, ""));
  }

  async mergePullRequest(
    repo: RepoRef,
    number: number,
  ): Promise<{ merged: boolean; sha: string | null; message: string }> {
    const r = this.repo(repo);
    const pr = await this.getPullRequest(repo, number);
    if (pr.state !== "open") return { merged: false, sha: null, message: "already closed" };
    if (!pr.mergeable)
      return { merged: false, sha: null, message: "Pull Request is not mergeable" };
    pr.state = "closed";
    pr.merged = true;
    const head = r.files.get(pr.head.ref);
    if (head)
      r.files.set(pr.base.ref, new Map([...(r.files.get(pr.base.ref) ?? new Map()), ...head]));
    return { merged: true, sha: `merge-${number}`, message: "merged" };
  }

  async commentOnPullRequest(repo: RepoRef, number: number, body: string): Promise<CommentInfo> {
    const r = this.repo(repo);
    const c: CommentInfo = {
      id: this.nextId++,
      body,
      author: this.login,
      createdAt: new Date(0).toISOString(),
      htmlUrl: `memory://${r.fullName}/c/${this.nextId - 1}`,
    };
    r.comments.set(number, [...(r.comments.get(number) ?? []), c]);
    return c;
  }

  async listPullRequestComments(repo: RepoRef, number: number): Promise<CommentInfo[]> {
    return this.repo(repo).comments.get(number) ?? [];
  }

  async reviewPullRequest(_repo: RepoRef, _number: number): Promise<{ id: number }> {
    return { id: this.nextId++ };
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
    return this.commentOnPullRequest(repo, number, body);
  }

  async listCheckRuns(repo: RepoRef, ref: string): Promise<CheckRunInfo[]> {
    return this.repo(repo).checks.get(ref) ?? [];
  }

  setCheckRuns(repo: RepoRef, ref: string, runs: CheckRunInfo[]): void {
    this.repo(repo).checks.set(ref, runs);
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
    return { name, downloadUrl: `${rel.htmlUrl}/${name}` };
  }

  async getLatestRelease(repo: RepoRef): Promise<ReleaseInfo | null> {
    const rels = this.repo(repo).releases.filter((x) => !x.draft);
    return rels.at(-1) ?? null;
  }

  async rateLimit(): Promise<{ limit: number; remaining: number; resetAt: string }> {
    return { limit: 5000, remaining: 5000, resetAt: new Date(0).toISOString() };
  }
}
