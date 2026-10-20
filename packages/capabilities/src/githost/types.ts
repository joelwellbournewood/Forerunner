/**
 * Git host contract (spec: "Git hosts (configurable) ... GitLab and plain git remotes via the
 * same adapter later"). GitHub is the first adapter; the fake git host in testenv speaks the
 * same REST shapes so one client serves both.
 */
export interface RepoRef {
  owner: string;
  name: string;
}

export interface RepoInfo extends RepoRef {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  permissions?: { pull: boolean; push: boolean; admin: boolean };
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  htmlUrl: string;
  draft: boolean;
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  htmlUrl: string;
}

export interface CommentInfo {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  htmlUrl: string;
}

export interface CheckRunInfo {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "skipped"
    | null;
  detailsUrl: string | null;
}

export interface ReleaseInfo {
  id: number;
  tagName: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  htmlUrl: string;
  assets: { name: string; size: number; downloadUrl: string }[];
}

export interface FileContent {
  path: string;
  sha: string;
  content: string;
  encoding: "utf8";
}

export interface GitHost {
  readonly kind: "github" | "gitlab" | "git";
  readonly baseUrl: string;
  whoAmI(): Promise<{ login: string }>;
  getRepo(repo: RepoRef): Promise<RepoInfo>;
  listRepos(opts?: { org?: string }): Promise<RepoInfo[]>;
  createRepo(opts: {
    owner?: string;
    name: string;
    private: boolean;
    description?: string;
  }): Promise<RepoInfo>;
  listBranches(repo: RepoRef): Promise<{ name: string; sha: string }[]>;
  getFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent | null>;
  putFile(
    repo: RepoRef,
    opts: { path: string; content: string; message: string; branch: string; sha?: string },
  ): Promise<{ sha: string }>;
  createPullRequest(
    repo: RepoRef,
    opts: { title: string; body: string; head: string; base: string; draft?: boolean },
  ): Promise<PullRequestInfo>;
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo>;
  listPullRequests(
    repo: RepoRef,
    opts?: { state?: "open" | "closed" | "all"; head?: string },
  ): Promise<PullRequestInfo[]>;
  mergePullRequest(
    repo: RepoRef,
    number: number,
    opts?: { method?: "merge" | "squash" | "rebase"; title?: string },
  ): Promise<{ merged: boolean; sha: string | null; message: string }>;
  commentOnPullRequest(repo: RepoRef, number: number, body: string): Promise<CommentInfo>;
  listPullRequestComments(repo: RepoRef, number: number): Promise<CommentInfo[]>;
  reviewPullRequest(
    repo: RepoRef,
    number: number,
    opts: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
  ): Promise<{ id: number }>;
  createIssue(
    repo: RepoRef,
    opts: { title: string; body: string; labels?: string[] },
  ): Promise<IssueInfo>;
  updateIssue(
    repo: RepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] },
  ): Promise<IssueInfo>;
  listIssues(
    repo: RepoRef,
    opts?: { state?: "open" | "closed" | "all"; labels?: string[] },
  ): Promise<IssueInfo[]>;
  commentOnIssue(repo: RepoRef, number: number, body: string): Promise<CommentInfo>;
  listCheckRuns(repo: RepoRef, ref: string): Promise<CheckRunInfo[]>;
  createRelease(
    repo: RepoRef,
    opts: { tagName: string; name: string; body: string; draft?: boolean; prerelease?: boolean },
  ): Promise<ReleaseInfo>;
  uploadReleaseAsset(
    repo: RepoRef,
    releaseId: number,
    name: string,
    data: Uint8Array,
    contentType?: string,
  ): Promise<{ name: string; downloadUrl: string }>;
  getLatestRelease(repo: RepoRef): Promise<ReleaseInfo | null>;
  rateLimit(): Promise<{ limit: number; remaining: number; resetAt: string }>;
}
