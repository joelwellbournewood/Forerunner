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
  /**
   * Whether the repository allows merge commits (GitHub's `allow_merge_commit`; ADR 0111:
   * Forerunner merges only with a merge commit). Absent when the host did not say.
   */
  allowMergeCommit?: boolean;
  /**
   * GitHub's numeric repository id (d1109-onerepo-link, ADR 0117): the same after a rename or a
   * transfer, so two names of one repository are told apart from two repositories. Absent when
   * the host did not say.
   */
  id?: number;
  /**
   * Whether the repository has issues turned on (GitHub's `has_issues`, w8-issue-host): when it
   * is false every issue call answers `issues_disabled` and the status stays in the app. Absent
   * when the host did not say.
   */
  hasIssues?: boolean;
}

/** How a pull request is merged; Forerunner itself always uses "merge" (ADR 0111). */
export type MergeMethod = "merge" | "squash" | "rebase";

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
  /** A merged pull request's merge commit on the base (GitHub's `merge_commit_sha`); else null. */
  mergeCommitSha?: string | null;
  /**
   * When the pull request was last updated (GitHub's `updated_at`) and the login of the account
   * that opened it (`user.login`): whether a Forerunner project that is not on this computer is
   * still worked on (d1109-onerepo-link, ADR 0117). Absent when the host did not say.
   */
  updatedAt?: string | null;
  authorLogin?: string | null;
}

/**
 * What a branch's rules ask of a merge into it (ADR 0111): the rulesets that apply to it
 * (`GET /repos/{o}/{r}/rules/branches/{b}`) and, when the token may read it, its classic
 * protection. Forerunner never goes around them: what it cannot satisfy (an approving review,
 * a code owner's review, signed commits, a merge queue, ...) is in `blockers`, in words, and
 * nothing merges; required checks are waited for as checks.
 */
export interface BranchRules {
  /** Approving reviews a pull request needs before it merges (0: none). */
  requiredApprovals: number;
  /** A code owner must approve. */
  codeOwnerReview: boolean;
  /** The branch must be up to date with the base before it merges. */
  upToDate: boolean;
  /** Check names (contexts) that must pass. */
  requiredChecks: string[];
  /** The merge methods the rules allow; null when they say nothing. */
  allowedMethods: MergeMethod[] | null;
  /** Other rules Forerunner cannot satisfy or cannot check, each a short phrase. */
  blockers: string[];
  /**
   * The branch is protected but its protection could not be read while this token could go
   * around it (an admin): nothing is known that would stop an admin's merge.
   */
  unreadable: boolean;
}

/**
 * How a comment's or an issue's author is related to the repository, as GitHub derives it
 * (`author_association`). Only a cheap first filter (w8-issue-host, D-W8-13): MEMBER is any
 * member of the organisation and COLLABORATOR includes the read role, so neither is write
 * access; write access is `getRepoPermission` (D-W8-37).
 */
export type AuthorAssociation =
  | "OWNER"
  | "MEMBER"
  | "COLLABORATOR"
  | "CONTRIBUTOR"
  | "FIRST_TIME_CONTRIBUTOR"
  | "FIRST_TIMER"
  | "MANNEQUIN"
  | "NONE";

const ASSOCIATIONS: ReadonlySet<string> = new Set<AuthorAssociation>([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
]);

/** GitHub's `author_association`, read strictly: anything else is NONE (it counts for nothing). */
export function associationOf(value: unknown): AuthorAssociation {
  return typeof value === "string" && ASSOCIATIONS.has(value)
    ? (value as AuthorAssociation)
    : "NONE";
}

/** The kind of account that wrote something (`user.type`): a GitHub App writes as a Bot. */
export type AccountType = "User" | "Bot" | "Organization";

/** `user.type` read strictly: a `[bot]` login is a Bot whatever the host said; anything else a User. */
export function accountTypeOf(login: string, value: unknown): AccountType {
  if (value === "Bot" || /\[bot\]$/i.test(login)) return "Bot";
  return value === "Organization" ? "Organization" : "User";
}

/**
 * A login's role on a repository (GitHub's `role_name` of the collaborator permission read,
 * w8-issue-host W8-host-8): admin, maintain and write may push; triage and read may not; none
 * has no access.
 */
export type RepoRole = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/** The roles that count as write access (D-W8-13, D-W8-37: only these writers count). */
export const WRITE_ROLES: readonly RepoRole[] = ["admin", "maintain", "write"];

/** Whether the role is write access (write, maintain or admin). */
export function hasWriteAccess(role: RepoRole): boolean {
  return WRITE_ROLES.includes(role);
}

const ROLES: ReadonlySet<string> = new Set<RepoRole>([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
]);

/**
 * GitHub's collaborator permission answer as a role: `role_name` when it is one of the five
 * built-in roles, else the legacy `permission` (a custom role's base: admin, write, read or
 * none); anything else is none (fails closed).
 */
export function roleOf(roleName: unknown, permission: unknown): RepoRole {
  if (typeof roleName === "string" && ROLES.has(roleName)) return roleName as RepoRole;
  if (typeof permission === "string" && ROLES.has(permission)) return permission as RepoRole;
  return "none";
}

/** GitHub pins at most three issues per repository. */
export const PINNED_ISSUES_MAX = 3;

/** What `pinIssue` answers: pinned (now or before), the repository's three pins are taken, or refused. */
export type PinResult = "pinned" | "limit" | "forbidden";

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  htmlUrl: string;
  /** GitHub's numeric issue id (not the number). */
  id: number;
  /** The issue's GraphQL node id: what `pinIssue` sends. */
  nodeId: string;
  /** Why it was closed (`completed`, `not_planned`, `reopened`), or null. */
  stateReason: string | null;
  locked: boolean;
  /** The login that opened it. */
  author: string;
  authorAssociation: AuthorAssociation;
  authorType: AccountType;
  createdAt: string;
  updatedAt: string;
  /** GitHub's issues endpoints also answer pull requests: true for one of them. */
  isPullRequest: boolean;
}

export interface CommentInfo {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  htmlUrl: string;
  /** When it was last edited (GitHub's `updated_at`); absent when the host did not say. */
  updatedAt?: string;
}

/**
 * A conversation comment on an issue (w8-issue-host, W8-host-1): exactly the fields GitHub's
 * REST comment has that the status issue needs. There is no editor: GitHub's REST comment does
 * not say who edited it, so neither stand-in does; a writer tells a tampered comment by
 * comparing its body with the text it last sent (w8-status-write).
 */
export interface IssueCommentInfo extends CommentInfo {
  issueNumber: number;
  updatedAt: string;
  authorAssociation: AuthorAssociation;
  authorType: AccountType;
}

/**
 * An issue's comments read with an ETag (w8-issue-host, W8-host-2): `etag` names what was read;
 * passed back as `opts.etag`, `notModified` is true when nothing changed since, and `comments`
 * is the same list (the adapter answers a 304 from its own copy, which costs no rate-limit
 * point). `etag` is null when the host gave none (then nothing is ever "not modified").
 */
export interface IssueCommentsRead {
  notModified: boolean;
  etag: string | null;
  comments: IssueCommentInfo[];
}

/** The newest comment of each author (by `updatedAt`, then id): one entry per login. */
export function newestCommentPerAuthor<T extends IssueCommentInfo>(comments: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const c of comments) {
    const key = c.author.toLowerCase();
    const seen = out.get(key);
    if (!seen || c.updatedAt > seen.updatedAt || (c.updatedAt === seen.updatedAt && c.id > seen.id))
      out.set(key, c);
  }
  return out;
}

/**
 * Why an issue call was refused, for the one sentence a caller says (w8-issue-host, W8-host-6;
 * the owner's status design: "stays in the app with one sentence when issues are off / no
 * permission / offline"):
 * - `issues_off`: the repository has issues turned off (`issues_disabled`, a 410);
 * - `no_permission`: the token may not do it (`tool_not_allowed`, a 403; or a `not_found` the
 *   adapter marked `details.reason: "no_permission"`, a 404 on a repository the token sees);
 * - `token_refused`: GitHub refused the token itself (`provider_auth`, a 401);
 * - `missing`: the issue or comment is not there (`not_found`, a 404 or a deleted issue's 410);
 * - `rate_limited`: GitHub's rate limit (`provider_rate_limit`);
 * - `unreachable`: GitHub did not answer, or answered 5xx after the retries (`provider_error`).
 * Null for anything else. `details.status` stays on the error for the log.
 */
export type IssueRefusal =
  | "issues_off"
  | "no_permission"
  | "token_refused"
  | "missing"
  | "rate_limited"
  | "unreachable";

export function issueRefusalOf(e: unknown): IssueRefusal | null {
  if (!e || typeof e !== "object") return null;
  const code = (e as { code?: unknown }).code;
  const details = ((e as { details?: unknown }).details ?? {}) as Record<string, unknown>;
  switch (code) {
    case "issues_disabled":
      return "issues_off";
    case "tool_not_allowed":
      return "no_permission";
    case "provider_auth":
      return "token_refused";
    case "not_found":
      return details.reason === "no_permission" ? "no_permission" : "missing";
    case "provider_rate_limit":
      return "rate_limited";
    case "provider_error":
      return "unreachable";
    default:
      return null;
  }
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
    /** Start the repository with a README commit (the host default); false: empty, for a first push. */
    autoInit?: boolean;
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
  /**
   * Edit a pull request (GitHub's `PATCH /pulls/:n`): its title, its body (a dependent pull
   * request's "Builds on" line once what it builds on changed), or close it.
   */
  updatePullRequest(
    repo: RepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed" },
  ): Promise<PullRequestInfo>;
  /**
   * The commit `branch` points at on the host, or null when there is no such branch (the git
   * host watcher reads the default branch's head once per poll).
   */
  getBranchHead(repo: RepoRef, branch: string): Promise<string | null>;
  /**
   * One page of the repository's pull requests (up to 100). `sort: "updated"` lists the most
   * recently updated first (GitHub's `sort=updated&direction=desc`), so a project's latest
   * activity is on the first page (d1109-onerepo-link).
   */
  listPullRequests(
    repo: RepoRef,
    opts?: { state?: "open" | "closed" | "all"; head?: string; sort?: "updated" },
  ): Promise<PullRequestInfo[]>;
  /**
   * Merge the pull request. `sha` pins the head the caller checked (the reviewed commit, the
   * one the checks ran on): the host refuses the merge when the head moved since (ADR 0062).
   */
  mergePullRequest(
    repo: RepoRef,
    number: number,
    opts?: { method?: MergeMethod; title?: string; sha?: string },
  ): Promise<{ merged: boolean; sha: string | null; message: string }>;
  /**
   * The rules a merge into `branch` must meet (ADR 0111): rulesets and, when readable, classic
   * protection. Throws when the host does not answer (the merge then waits, never guesses).
   */
  getBranchRules(repo: RepoRef, branch: string): Promise<BranchRules>;
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
  // ---- issues (w8-issue-host: the status issue's host calls; this port writes nothing by itself)
  // Every call answers `issues_disabled` (status 410) when the repository has issues off; read
  // `issueRefusalOf` for the reason of any refusal. Comment and issue text is returned as data,
  // with its author: nothing here parses or follows it.
  createIssue(
    repo: RepoRef,
    opts: { title: string; body: string; labels?: string[] },
  ): Promise<IssueInfo>;
  updateIssue(
    repo: RepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] },
  ): Promise<IssueInfo>;
  /**
   * One issue (read with the ETag: a repeated read is a 304): its node id, state and state
   * reason, locked flag, author and times. Throws `not_found` when there is none.
   */
  getIssue(repo: RepoRef, number: number): Promise<IssueInfo>;
  /**
   * The repository's issues, pull requests left out, every page (the adapter follows the
   * pagination), read with the ETag. `creator` keeps one login's; `labels` those carrying every
   * label; `sort` and `direction` as GitHub's (default: created, newest first).
   */
  listIssues(
    repo: RepoRef,
    opts?: {
      state?: "open" | "closed" | "all";
      labels?: string[];
      creator?: string;
      sort?: "created" | "updated" | "comments";
      direction?: "asc" | "desc";
    },
  ): Promise<IssueInfo[]>;
  commentOnIssue(repo: RepoRef, number: number, body: string): Promise<IssueCommentInfo>;
  /**
   * Every comment of one issue, oldest first, each with its author, the author's association
   * and type, and its created and updated times (every page). With `opts.etag` from an earlier
   * read, `notModified` says whether anything changed since; a repeated read is answered by a
   * 304 the adapter serves from its in-memory copy. `since` keeps comments updated at or after it.
   */
  listIssueComments(
    repo: RepoRef,
    number: number,
    opts?: { etag?: string; since?: string },
  ): Promise<IssueCommentsRead>;
  /** One issue comment by id, or null when it is gone (deleted). */
  getIssueComment(repo: RepoRef, id: number): Promise<IssueCommentInfo | null>;
  /**
   * Edit an issue comment in place (GitHub's `PATCH /issues/comments/:id`), with the agent's
   * mark as every comment the port writes. GitHub lets anyone with write access edit any
   * comment, and so do the stand-ins; Forerunner editing only its own is the caller's rule.
   * There is no delete: Forerunner never deletes a comment.
   */
  updateIssueComment(repo: RepoRef, id: number, body: string): Promise<IssueCommentInfo>;
  /**
   * Pin the issue (GitHub pins only through the GraphQL `pinIssue` mutation on the issue's node
   * id): `pinned` (now or already), `limit` when the repository's three pins are taken (nothing
   * is unpinned), `forbidden` when the token may not pin.
   */
  pinIssue(repo: RepoRef, number: number): Promise<PinResult>;
  /**
   * `login`'s role on the repository (GitHub's collaborator permission read, read with the
   * ETag per login and token): the one source of write access (D-W8-37; association is only a
   * first filter). A refused read (401, 403 or 404, e.g. a token without push access) answers
   * `none`: it fails closed. GitHub not answering throws.
   */
  getRepoPermission(repo: RepoRef, login: string): Promise<RepoRole>;
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
