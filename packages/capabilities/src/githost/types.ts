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

/** A review (line) comment on a pull request's diff (`GET /pulls/:n/comments`). */
export interface ReviewCommentInfo extends CommentInfo {
  /** The review it belongs to (every line comment is part of one), or null. */
  reviewId: number | null;
  path: string;
  line: number | null;
  /** The comment it answers in a thread, or null for the first of a thread. */
  inReplyTo: number | null;
}

/**
 * The hidden mark every comment and review Forerunner writes through the port carries (an
 * HTML comment: GitHub does not render it). The git host poller (ADR 0075) tells the agent's
 * own text from the human's by it, since the host token is often the human's own PAT and the
 * login alone cannot.
 */
export const AGENT_TEXT_MARKER = "<!-- forerunner:agent -->";

/** The text with the agent's mark appended (once). */
export function markAgentText(body: string): string {
  if (body.includes(AGENT_TEXT_MARKER)) return body;
  return body ? `${body}\n\n${AGENT_TEXT_MARKER}` : AGENT_TEXT_MARKER;
}

/** Whether a comment or review body carries the agent's mark. */
export function isAgentText(body: string): boolean {
  return body.includes(AGENT_TEXT_MARKER);
}

/** A submitted review of a pull request (its summary text, not the line comments). */
export interface ReviewInfo {
  id: number;
  body: string;
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string | null;
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

/**
 * A commit status (the older status API, the one Jenkins and many external CIs report
 * through), the latest per `context` on a commit.
 */
export interface CommitStatusInfo {
  id: number;
  context: string;
  state: "pending" | "success" | "failure" | "error";
  targetUrl: string | null;
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

/**
 * Projects (GitHub Projects V2, the one-way task mirror target). A project belongs to a user
 * or organisation, has typed fields and holds items. Items the mirror creates are draft
 * issues tagged with the Forerunner task id in a text field so every write is idempotent.
 */
export const FORERUNNER_TASK_ID_FIELD = "forerunner_task_id";

export interface ProjectInfo {
  /** Host node id (GraphQL id on GitHub). */
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
}

export type ProjectFieldKind = "text" | "single_select" | "number" | "date" | "iteration" | "other";

export type ProjectOptionColor =
  | "GRAY"
  | "BLUE"
  | "GREEN"
  | "YELLOW"
  | "ORANGE"
  | "RED"
  | "PINK"
  | "PURPLE";

export interface ProjectFieldOption {
  name: string;
  color?: ProjectOptionColor;
  description?: string;
}

/** What a field must look like; `ensureFields` creates it or adds missing options. */
export interface ProjectFieldSpec {
  name: string;
  kind: "text" | "single_select";
  /** Single-select options in display order. Existing options are kept, missing ones added. */
  options?: ProjectFieldOption[];
}

export interface ProjectFieldInfo {
  id: string;
  name: string;
  kind: ProjectFieldKind;
  options: { id: string; name: string }[];
}

/** Field values by field name; a single-select value is the option name; null clears. */
export type ProjectItemFields = Record<string, string | null>;

export interface ProjectItemInput {
  forerunnerTaskId: string;
  title: string;
  body?: string;
  fields?: ProjectItemFields;
}

export interface ProjectItemInfo {
  id: string;
  forerunnerTaskId: string | null;
  title: string;
  body: string;
  archived: boolean;
  fields: ProjectItemFields;
  /** Item type on the host: a draft the mirror owns, or an issue / PR a human added. */
  kind: "draft" | "issue" | "pull_request" | "other";
}

export interface UpsertItemResult {
  item: ProjectItemInfo;
  created: boolean;
}

export interface GitHost {
  readonly kind: "github" | "gitlab" | "git";
  readonly baseUrl: string;
  whoAmI(): Promise<{ login: string }>;
  getRepo(repo: RepoRef): Promise<RepoInfo>;
  /**
   * Repositories of an organisation (`org`), the public ones of a user (`user`) or every one
   * the token is affiliated with (neither); the adapter follows the host's pagination.
   */
  listRepos(opts?: { org?: string; user?: string }): Promise<RepoInfo[]>;
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
  /**
   * Merge the pull request. `sha` pins the head the caller checked (the reviewed commit, the
   * one the checks ran on): the host refuses the merge when the head moved since (ADR 0062).
   */
  mergePullRequest(
    repo: RepoRef,
    number: number,
    opts?: { method?: "merge" | "squash" | "rebase"; title?: string; sha?: string },
  ): Promise<{ merged: boolean; sha: string | null; message: string }>;
  commentOnPullRequest(repo: RepoRef, number: number, body: string): Promise<CommentInfo>;
  /**
   * Every conversation comment of the pull request, oldest first (the adapter follows the
   * host's pagination). `since` (ISO-8601) keeps the comments updated at or after it.
   */
  listPullRequestComments(
    repo: RepoRef,
    number: number,
    opts?: { since?: string },
  ): Promise<CommentInfo[]>;
  /** Every review of the pull request, oldest first (the adapter follows the pagination). */
  listPullRequestReviews(repo: RepoRef, number: number): Promise<ReviewInfo[]>;
  /**
   * Every review (line) comment of the pull request, oldest first (the adapter follows the
   * pagination). `since` (ISO-8601) keeps the comments updated at or after it.
   */
  listPullRequestReviewComments(
    repo: RepoRef,
    number: number,
    opts?: { since?: string },
  ): Promise<ReviewCommentInfo[]>;
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
  /** The latest commit status per context on `ref` (the combined status's entries). */
  listCommitStatuses(repo: RepoRef, ref: string): Promise<CommitStatusInfo[]>;
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
  // ---- projects (one-way task mirror) ---------------------------------------------------------
  /** Find the open project with this exact title under `owner` (user or org) or create it. */
  ensureProject(owner: string, title: string): Promise<ProjectInfo>;
  /** Create missing fields and missing single-select options; returns every field of the project. */
  ensureFields(projectId: string, fields: ProjectFieldSpec[]): Promise<ProjectFieldInfo[]>;
  /** Every item of the project, archived ones included. */
  listProjectItems(projectId: string): Promise<ProjectItemInfo[]>;
  /** The item carrying this Forerunner task id, or null. */
  findItem(projectId: string, forerunnerTaskId: string): Promise<ProjectItemInfo | null>;
  /**
   * Create or update the item for `forerunnerTaskId` (idempotent): a new draft issue gets the
   * id field set; an existing one gets its title, body and fields updated and is unarchived.
   */
  upsertItem(projectId: string, item: ProjectItemInput): Promise<UpsertItemResult>;
  /** Set field values by name (single-select by option name; null clears). Unknown names throw `validation`. */
  setItemFields(projectId: string, itemId: string, fields: ProjectItemFields): Promise<void>;
  archiveItem(projectId: string, itemId: string): Promise<void>;
}
