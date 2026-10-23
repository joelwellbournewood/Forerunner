/**
 * In-memory state of the fake git host plus the serializers that render it in GitHub's REST
 * shapes. Git data (commits, trees, refs) lives in the bare repos; everything else (users,
 * tokens, issues, pull requests, releases, hooks, projects) lives here and dies with the host.
 */
import type { Clock } from "@forerunner/platform";
import { type AccessSubject, checkRepoAccess, type TokenRecord } from "./auth.ts";
import type { BareRepo, CommitInfo, DiffFile } from "./git.ts";
import type {
  HostEvent,
  PermissionLevel,
  RepoPermission,
  RequestLogEntry,
  WebhookEventName,
} from "./types.ts";

export type Json = Record<string, unknown>;

export interface UserRecord {
  id: number;
  login: string;
  name: string;
  email: string;
  type: "User" | "Organization";
  /** Lowercase member logins (orgs only). */
  members: Set<string>;
  createdAt: string;
}

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string;
  isDefault: boolean;
}

export interface CommentRecord {
  id: number;
  issueNumber: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";

export interface ReviewRecord {
  id: number;
  user: string;
  body: string;
  state: ReviewState;
  commitId: string;
  submittedAt: string;
}

/** A review (line) comment: in a review, or a reply to one (`inReplyTo`). */
export interface ReviewCommentRecord {
  id: number;
  reviewId: number | null;
  user: string;
  body: string;
  path: string;
  line: number | null;
  commitId: string;
  inReplyTo: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PullData {
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergedBy: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean | null;
  mergeableState: "clean" | "dirty" | "unknown";
  draft: boolean;
  reviews: ReviewRecord[];
  reviewComments: ReviewCommentRecord[];
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  user: string;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pull: PullData | null;
}

export interface ReleaseAssetRecord {
  id: number;
  name: string;
  label: string | null;
  contentType: string;
  size: number;
  content: Buffer;
  sha256: string;
  uploader: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseRecord {
  id: number;
  tagName: string;
  targetCommitish: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  author: string;
  createdAt: string;
  publishedAt: string | null;
  assets: Map<number, ReleaseAssetRecord>;
}

export interface CheckRunRecord {
  id: number;
  headSha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  externalId: string | null;
  output: { title: string | null; summary: string | null; text: string | null };
  app: string;
}

export interface StatusRecord {
  id: number;
  sha: string;
  state: "error" | "failure" | "pending" | "success";
  description: string | null;
  targetUrl: string | null;
  context: string;
  creator: string;
  createdAt: string;
  updatedAt: string;
}

export interface HookRecord {
  id: number;
  active: boolean;
  events: string[];
  url: string;
  contentType: "json" | "form";
  secret: string | null;
  insecureSsl: string;
  createdAt: string;
  updatedAt: string;
  lastResponse: { code: number | null; status: string; message: string | null };
}

export interface ProjectRecord {
  id: number;
  number: number;
  name: string;
  body: string;
  state: "open" | "closed";
  repo: RepoRecord;
  creator: string;
  createdAt: string;
  updatedAt: string;
  columns: ColumnRecord[];
}

export interface ColumnRecord {
  id: number;
  name: string;
  project: ProjectRecord;
  cards: CardRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface CardRecord {
  id: number;
  note: string | null;
  archived: boolean;
  column: ColumnRecord;
  contentId: number | null;
  contentType: "Issue" | "PullRequest" | null;
  creator: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppRecord {
  id: number;
  slug: string;
  name: string;
  owner: string;
}

export interface InstallationRecord {
  id: number;
  appId: number;
  account: string;
  repos: string[] | "all";
  permissions: Partial<Record<RepoPermission, PermissionLevel>>;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string;
  dir: string;
  git: BareRepo;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  nextNumber: number;
  nextProjectNumber: number;
  issues: Map<number, IssueRecord>;
  comments: Map<number, CommentRecord>;
  labels: Map<string, LabelRecord>;
  releases: Map<number, ReleaseRecord>;
  checkRuns: Map<number, CheckRunRecord>;
  statuses: StatusRecord[];
  hooks: Map<number, HookRecord>;
  projects: ProjectRecord[];
  /** Lowercase logins with push access besides the owner (and org members). */
  collaborators: Set<string>;
}

export const DEFAULT_LABELS: Array<[string, string, string]> = [
  ["bug", "d73a4a", "Something isn't working"],
  ["documentation", "0075ca", "Improvements or additions to documentation"],
  ["enhancement", "a2eeef", "New feature or request"],
  ["question", "d876e3", "Further information is requested"],
];

export class HostStore {
  readonly users = new Map<string, UserRecord>();
  readonly repos = new Map<string, RepoRecord>();
  readonly tokens = new Map<string, TokenRecord>();
  readonly tokensById = new Map<number, TokenRecord>();
  readonly apps = new Map<number, AppRecord>();
  readonly installations = new Map<number, InstallationRecord>();
  readonly projects = new Map<number, ProjectRecord>();
  readonly columns = new Map<number, ColumnRecord>();
  readonly cards = new Map<number, CardRecord>();
  readonly checkRunsById = new Map<number, { repo: RepoRecord; run: CheckRunRecord }>();
  readonly assetsById = new Map<
    number,
    { repo: RepoRecord; release: ReleaseRecord; asset: ReleaseAssetRecord }
  >();
  readonly events: HostEvent[] = [];
  readonly requests: RequestLogEntry[] = [];
  /** Set by the host once it listens. */
  baseUrl = "http://127.0.0.1";
  onEvent: ((repo: RepoRecord, event: HostEvent) => void) | null = null;
  private idCounter = 1000;
  private eventCounter = 0;

  constructor(readonly clock: Clock) {}

  nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  nodeId(type: string, id: number): string {
    return Buffer.from(`${type}:${id}`).toString("base64");
  }

  // ---- lookups --------------------------------------------------------------------------

  user(login: string): UserRecord | undefined {
    return this.users.get(login.toLowerCase());
  }

  repo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(`${owner}/${name.replace(/\.git$/i, "")}`.toLowerCase());
  }

  repoByFullName(fullName: string): RepoRecord | undefined {
    return this.repos.get(fullName.toLowerCase());
  }

  /** The owner itself plus every org it belongs to (lowercase). */
  affiliations(login: string): Set<string> {
    const out = new Set<string>([login.toLowerCase()]);
    for (const u of this.users.values()) {
      if (u.type === "Organization" && u.members.has(login.toLowerCase()))
        out.add(u.login.toLowerCase());
    }
    return out;
  }

  subjectFor(token: TokenRecord | null): AccessSubject {
    return {
      token,
      affiliations: token ? this.affiliations(token.owner) : new Set<string>(),
    };
  }

  issue(repo: RepoRecord, number: number): IssueRecord | undefined {
    return repo.issues.get(number);
  }

  pull(repo: RepoRecord, number: number): (IssueRecord & { pull: PullData }) | undefined {
    const i = repo.issues.get(number);
    return i?.pull ? (i as IssueRecord & { pull: PullData }) : undefined;
  }

  // ---- events ----------------------------------------------------------------------------

  emit(
    repo: RepoRecord,
    event: WebhookEventName,
    action: string | null,
    payload: Json,
    sender: string,
  ): HostEvent {
    this.eventCounter += 1;
    const senderUser = this.user(sender);
    const full: Json = {
      ...(action ? { action } : {}),
      ...payload,
      repository: this.repoJson(repo, null),
      sender: senderUser ? this.userJson(senderUser) : this.ghostUser(sender),
    };
    const ev: HostEvent = {
      id: `${this.eventCounter}`.padStart(6, "0"),
      event,
      action,
      repo: repo.fullName,
      payload: full,
      at: this.clock.nowIso(),
      deliveries: [],
    };
    this.events.push(ev);
    this.onEvent?.(repo, ev);
    return ev;
  }

  // ---- serializers -----------------------------------------------------------------------

  private api(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  ghostUser(login: string): Json {
    return {
      login,
      id: 0,
      node_id: this.nodeId("User", 0),
      type: "User",
      site_admin: false,
      html_url: this.api(`/${login}`),
      url: this.api(`/users/${login}`),
      avatar_url: this.api(`/avatars/${login}.png`),
    };
  }

  userJson(u: UserRecord): Json {
    return {
      login: u.login,
      id: u.id,
      node_id: this.nodeId(u.type, u.id),
      avatar_url: this.api(`/avatars/${u.login}.png`),
      html_url: this.api(`/${u.login}`),
      url: this.api(u.type === "Organization" ? `/orgs/${u.login}` : `/users/${u.login}`),
      type: u.type,
      site_admin: false,
      name: u.name,
      email: u.email,
      created_at: u.createdAt,
      updated_at: u.createdAt,
    };
  }

  userJsonByLogin(login: string): Json {
    const u = this.user(login);
    return u ? this.userJson(u) : this.ghostUser(login);
  }

  repoJson(repo: RepoRecord, subject: AccessSubject | null): Json {
    const owner = this.user(repo.owner);
    const base = `/repos/${repo.fullName}`;
    const pull = subject ? checkRepoAccess(subject, repo, "contents", "read") === "ok" : false;
    const push = subject ? checkRepoAccess(subject, repo, "contents", "write") === "ok" : false;
    const admin = subject
      ? checkRepoAccess(subject, repo, "administration", "write") === "ok"
      : false;
    const openIssues = [...repo.issues.values()].filter((i) => i.state === "open").length;
    return {
      id: repo.id,
      node_id: this.nodeId("Repository", repo.id),
      name: repo.name,
      full_name: repo.fullName,
      private: repo.private,
      owner: owner ? this.userJson(owner) : this.ghostUser(repo.owner),
      html_url: this.api(`/${repo.fullName}`),
      description: repo.description,
      fork: false,
      url: this.api(base),
      clone_url: this.api(`/${repo.fullName}.git`),
      git_url: this.api(`/${repo.fullName}.git`),
      ssh_url: `git@fake-git-host:${repo.fullName}.git`,
      default_branch: repo.defaultBranch,
      visibility: repo.private ? "private" : "public",
      archived: false,
      disabled: false,
      has_issues: true,
      has_projects: true,
      has_wiki: false,
      topics: [],
      open_issues_count: openIssues,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      pushed_at: repo.pushedAt,
      permissions: { admin, maintain: admin, push, triage: push, pull },
      branches_url: this.api(`${base}/branches{/branch}`),
      contents_url: this.api(`${base}/contents/{+path}`),
      pulls_url: this.api(`${base}/pulls{/number}`),
      issues_url: this.api(`${base}/issues{/number}`),
      releases_url: this.api(`${base}/releases{/id}`),
      hooks_url: this.api(`${base}/hooks`),
    };
  }

  labelJson(repo: RepoRecord, l: LabelRecord): Json {
    return {
      id: l.id,
      node_id: this.nodeId("Label", l.id),
      url: this.api(`/repos/${repo.fullName}/labels/${encodeURIComponent(l.name)}`),
      name: l.name,
      color: l.color,
      default: l.isDefault,
      description: l.description,
    };
  }

  issueLabels(repo: RepoRecord, issue: IssueRecord): Json[] {
    return issue.labels.map((name) => {
      const l = repo.labels.get(name.toLowerCase());
      return l
        ? this.labelJson(repo, l)
        : {
            id: 0,
            node_id: this.nodeId("Label", 0),
            name,
            color: "ededed",
            default: false,
            description: null,
          };
    });
  }

  issueJson(repo: RepoRecord, issue: IssueRecord): Json {
    const base = `/repos/${repo.fullName}`;
    const comments = [...repo.comments.values()].filter(
      (c) => c.issueNumber === issue.number,
    ).length;
    const out: Json = {
      id: issue.id,
      node_id: this.nodeId("Issue", issue.id),
      url: this.api(`${base}/issues/${issue.number}`),
      repository_url: this.api(base),
      labels_url: this.api(`${base}/issues/${issue.number}/labels{/name}`),
      comments_url: this.api(`${base}/issues/${issue.number}/comments`),
      html_url: this.api(`/${repo.fullName}/${issue.pull ? "pull" : "issues"}/${issue.number}`),
      number: issue.number,
      state: issue.state,
      state_reason: issue.stateReason,
      title: issue.title,
      body: issue.body,
      user: this.userJsonByLogin(issue.user),
      labels: this.issueLabels(repo, issue),
      assignees: issue.assignees.map((a) => this.userJsonByLogin(a)),
      assignee: issue.assignees[0] ? this.userJsonByLogin(issue.assignees[0]) : null,
      locked: false,
      comments,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      author_association: "OWNER",
    };
    if (issue.pull) {
      out.pull_request = {
        url: this.api(`${base}/pulls/${issue.number}`),
        html_url: this.api(`/${repo.fullName}/pull/${issue.number}`),
        diff_url: this.api(`/${repo.fullName}/pull/${issue.number}.diff`),
        patch_url: this.api(`/${repo.fullName}/pull/${issue.number}.patch`),
        merged_at: issue.pull.mergedAt,
      };
    }
    return out;
  }

  pullJson(
    repo: RepoRecord,
    issue: IssueRecord & { pull: PullData },
    stats?: { commits: number; files: DiffFile[] },
  ): Json {
    const p = issue.pull;
    const base = `/repos/${repo.fullName}`;
    const ownerUser = this.user(repo.owner);
    const comments = [...repo.comments.values()].filter(
      (c) => c.issueNumber === issue.number,
    ).length;
    const repoJson = this.repoJson(repo, null);
    const additions = stats?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
    const deletions = stats?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;
    return {
      id: issue.id,
      node_id: this.nodeId("PullRequest", issue.id),
      url: this.api(`${base}/pulls/${issue.number}`),
      html_url: this.api(`/${repo.fullName}/pull/${issue.number}`),
      diff_url: this.api(`/${repo.fullName}/pull/${issue.number}.diff`),
      patch_url: this.api(`/${repo.fullName}/pull/${issue.number}.patch`),
      issue_url: this.api(`${base}/issues/${issue.number}`),
      commits_url: this.api(`${base}/pulls/${issue.number}/commits`),
      review_comments_url: this.api(`${base}/pulls/${issue.number}/comments`),
      comments_url: this.api(`${base}/issues/${issue.number}/comments`),
      statuses_url: this.api(`${base}/statuses/${p.headSha}`),
      number: issue.number,
      state: issue.state,
      locked: false,
      title: issue.title,
      user: this.userJsonByLogin(issue.user),
      body: issue.body,
      labels: this.issueLabels(repo, issue),
      assignees: issue.assignees.map((a) => this.userJsonByLogin(a)),
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      merged_at: p.mergedAt,
      merge_commit_sha: p.mergeCommitSha,
      draft: p.draft,
      head: {
        label: `${repo.owner}:${p.headRef}`,
        ref: p.headRef,
        sha: p.headSha,
        user: ownerUser ? this.userJson(ownerUser) : this.ghostUser(repo.owner),
        repo: repoJson,
      },
      base: {
        label: `${repo.owner}:${p.baseRef}`,
        ref: p.baseRef,
        sha: p.baseSha,
        user: ownerUser ? this.userJson(ownerUser) : this.ghostUser(repo.owner),
        repo: repoJson,
      },
      author_association: "OWNER",
      auto_merge: null,
      merged: p.merged,
      mergeable: p.mergeable,
      rebaseable: p.mergeable,
      mergeable_state: p.mergeableState,
      merged_by: p.mergedBy ? this.userJsonByLogin(p.mergedBy) : null,
      comments,
      review_comments: 0,
      maintainer_can_modify: false,
      commits: stats?.commits ?? 0,
      additions,
      deletions,
      changed_files: stats?.files.length ?? 0,
    };
  }

  reviewJson(repo: RepoRecord, issue: IssueRecord, r: ReviewRecord): Json {
    return {
      id: r.id,
      node_id: this.nodeId("PullRequestReview", r.id),
      user: this.userJsonByLogin(r.user),
      body: r.body,
      state: r.state,
      html_url: this.api(`/${repo.fullName}/pull/${issue.number}#pullrequestreview-${r.id}`),
      pull_request_url: this.api(`/repos/${repo.fullName}/pulls/${issue.number}`),
      commit_id: r.commitId,
      submitted_at: r.submittedAt,
      author_association: "OWNER",
    };
  }

  reviewCommentJson(repo: RepoRecord, issue: IssueRecord, rc: ReviewCommentRecord): Json {
    return {
      id: rc.id,
      node_id: this.nodeId("PullRequestReviewComment", rc.id),
      url: this.api(`/repos/${repo.fullName}/pulls/comments/${rc.id}`),
      html_url: this.api(`/${repo.fullName}/pull/${issue.number}#discussion_r${rc.id}`),
      pull_request_url: this.api(`/repos/${repo.fullName}/pulls/${issue.number}`),
      pull_request_review_id: rc.reviewId,
      in_reply_to_id: rc.inReplyTo ?? undefined,
      path: rc.path,
      line: rc.line,
      commit_id: rc.commitId,
      body: rc.body,
      user: this.userJsonByLogin(rc.user),
      created_at: rc.createdAt,
      updated_at: rc.updatedAt,
      author_association: "OWNER",
    };
  }

  commentJson(repo: RepoRecord, c: CommentRecord): Json {
    const issue = repo.issues.get(c.issueNumber);
    return {
      id: c.id,
      node_id: this.nodeId("IssueComment", c.id),
      url: this.api(`/repos/${repo.fullName}/issues/comments/${c.id}`),
      html_url: this.api(
        `/${repo.fullName}/${issue?.pull ? "pull" : "issues"}/${c.issueNumber}#issuecomment-${c.id}`,
      ),
      issue_url: this.api(`/repos/${repo.fullName}/issues/${c.issueNumber}`),
      body: c.body,
      user: this.userJsonByLogin(c.user),
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      author_association: "OWNER",
    };
  }

  assetJson(repo: RepoRecord, release: ReleaseRecord, a: ReleaseAssetRecord): Json {
    return {
      id: a.id,
      node_id: this.nodeId("ReleaseAsset", a.id),
      url: this.api(`/repos/${repo.fullName}/releases/assets/${a.id}`),
      name: a.name,
      label: a.label,
      content_type: a.contentType,
      state: "uploaded",
      size: a.size,
      digest: `sha256:${a.sha256}`,
      download_count: 0,
      browser_download_url: this.api(
        `/${repo.fullName}/releases/download/${encodeURIComponent(release.tagName)}/${encodeURIComponent(a.name)}`,
      ),
      uploader: this.userJsonByLogin(a.uploader),
      created_at: a.createdAt,
      updated_at: a.updatedAt,
    };
  }

  releaseJson(repo: RepoRecord, r: ReleaseRecord): Json {
    const base = `/repos/${repo.fullName}/releases`;
    return {
      id: r.id,
      node_id: this.nodeId("Release", r.id),
      url: this.api(`${base}/${r.id}`),
      html_url: this.api(`/${repo.fullName}/releases/tag/${encodeURIComponent(r.tagName)}`),
      assets_url: this.api(`${base}/${r.id}/assets`),
      upload_url: this.api(`${base}/${r.id}/assets{?name,label}`),
      tarball_url: this.api(`${base}/tarball/${encodeURIComponent(r.tagName)}`),
      zipball_url: this.api(`${base}/zipball/${encodeURIComponent(r.tagName)}`),
      tag_name: r.tagName,
      target_commitish: r.targetCommitish,
      name: r.name,
      body: r.body,
      draft: r.draft,
      prerelease: r.prerelease,
      author: this.userJsonByLogin(r.author),
      created_at: r.createdAt,
      published_at: r.publishedAt,
      assets: [...r.assets.values()].map((a) => this.assetJson(repo, r, a)),
    };
  }

  checkRunJson(repo: RepoRecord, c: CheckRunRecord): Json {
    const pulls = [...repo.issues.values()]
      .filter((i) => i.pull && i.pull.headSha === c.headSha && i.state === "open")
      .map((i) => ({
        url: this.api(`/repos/${repo.fullName}/pulls/${i.number}`),
        id: i.id,
        number: i.number,
        head: { ref: i.pull?.headRef, sha: i.pull?.headSha },
        base: { ref: i.pull?.baseRef, sha: i.pull?.baseSha },
      }));
    return {
      id: c.id,
      node_id: this.nodeId("CheckRun", c.id),
      head_sha: c.headSha,
      external_id: c.externalId,
      url: this.api(`/repos/${repo.fullName}/check-runs/${c.id}`),
      html_url: this.api(`/${repo.fullName}/runs/${c.id}`),
      details_url: c.detailsUrl,
      status: c.status,
      conclusion: c.conclusion,
      started_at: c.startedAt,
      completed_at: c.completedAt,
      output: { ...c.output, annotations_count: 0, annotations_url: null },
      name: c.name,
      check_suite: { id: c.id },
      app: { id: 1, slug: c.app, name: c.app, owner: this.ghostUser(c.app) },
      pull_requests: pulls,
    };
  }

  statusJson(repo: RepoRecord, s: StatusRecord): Json {
    return {
      id: s.id,
      node_id: this.nodeId("Status", s.id),
      url: this.api(`/repos/${repo.fullName}/statuses/${s.sha}`),
      state: s.state,
      description: s.description,
      target_url: s.targetUrl,
      context: s.context,
      creator: this.userJsonByLogin(s.creator),
      created_at: s.createdAt,
      updated_at: s.updatedAt,
    };
  }

  hookJson(repo: RepoRecord, h: HookRecord): Json {
    const base = `/repos/${repo.fullName}/hooks/${h.id}`;
    return {
      id: h.id,
      type: "Repository",
      name: "web",
      active: h.active,
      events: h.events,
      config: {
        url: h.url,
        content_type: h.contentType,
        insecure_ssl: h.insecureSsl,
        ...(h.secret ? { secret: "********" } : {}),
      },
      url: this.api(base),
      test_url: this.api(`${base}/test`),
      ping_url: this.api(`${base}/pings`),
      deliveries_url: this.api(`${base}/deliveries`),
      created_at: h.createdAt,
      updated_at: h.updatedAt,
      last_response: h.lastResponse,
    };
  }

  projectJson(p: ProjectRecord): Json {
    return {
      id: p.id,
      node_id: this.nodeId("Project", p.id),
      number: p.number,
      name: p.name,
      body: p.body,
      state: p.state,
      owner_url: this.api(`/repos/${p.repo.fullName}`),
      url: this.api(`/projects/${p.id}`),
      html_url: this.api(`/${p.repo.fullName}/projects/${p.number}`),
      columns_url: this.api(`/projects/${p.id}/columns`),
      creator: this.userJsonByLogin(p.creator),
      created_at: p.createdAt,
      updated_at: p.updatedAt,
    };
  }

  columnJson(c: ColumnRecord): Json {
    return {
      id: c.id,
      node_id: this.nodeId("ProjectColumn", c.id),
      name: c.name,
      url: this.api(`/projects/columns/${c.id}`),
      project_url: this.api(`/projects/${c.project.id}`),
      cards_url: this.api(`/projects/columns/${c.id}/cards`),
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    };
  }

  cardJson(card: CardRecord): Json {
    const repo = card.column.project.repo;
    const contentUrl =
      card.contentId !== null
        ? this.api(
            `/repos/${repo.fullName}/${card.contentType === "PullRequest" ? "pulls" : "issues"}/${card.contentId}`,
          )
        : undefined;
    return {
      id: card.id,
      node_id: this.nodeId("ProjectCard", card.id),
      note: card.note,
      archived: card.archived,
      creator: this.userJsonByLogin(card.creator),
      created_at: card.createdAt,
      updated_at: card.updatedAt,
      url: this.api(`/projects/columns/cards/${card.id}`),
      column_url: this.api(`/projects/columns/${card.column.id}`),
      project_url: this.api(`/projects/${card.column.project.id}`),
      ...(contentUrl ? { content_url: contentUrl } : {}),
    };
  }

  commitJson(repo: RepoRecord, c: CommitInfo, extra: Json = {}): Json {
    const base = `/repos/${repo.fullName}`;
    const authorUser = [...this.users.values()].find((u) => u.email === c.author.email);
    const committerUser = [...this.users.values()].find((u) => u.email === c.committer.email);
    return {
      sha: c.sha,
      node_id: this.nodeId("Commit", 0),
      url: this.api(`${base}/commits/${c.sha}`),
      html_url: this.api(`/${repo.fullName}/commit/${c.sha}`),
      comments_url: this.api(`${base}/commits/${c.sha}/comments`),
      commit: {
        url: this.api(`${base}/git/commits/${c.sha}`),
        message: c.message,
        author: { name: c.author.name, email: c.author.email, date: c.author.date },
        committer: { name: c.committer.name, email: c.committer.email, date: c.committer.date },
        tree: { sha: c.tree, url: this.api(`${base}/git/trees/${c.tree}`) },
        comment_count: 0,
        verification: { verified: false, reason: "unsigned", signature: null, payload: null },
      },
      author: authorUser ? this.userJson(authorUser) : null,
      committer: committerUser ? this.userJson(committerUser) : null,
      parents: c.parents.map((p) => ({
        sha: p,
        url: this.api(`${base}/commits/${p}`),
        html_url: this.api(`/${repo.fullName}/commit/${p}`),
      })),
      ...extra,
    };
  }

  /** Commit as it appears inside a `push` webhook payload. */
  pushCommitJson(repo: RepoRecord, c: CommitInfo, files: DiffFile[]): Json {
    return {
      id: c.sha,
      tree_id: c.tree,
      distinct: true,
      message: c.message,
      timestamp: c.author.date,
      url: this.api(`/${repo.fullName}/commit/${c.sha}`),
      author: { name: c.author.name, email: c.author.email },
      committer: { name: c.committer.name, email: c.committer.email },
      added: files.filter((f) => f.status === "added").map((f) => f.filename),
      removed: files.filter((f) => f.status === "removed").map((f) => f.filename),
      modified: files
        .filter((f) => f.status !== "added" && f.status !== "removed")
        .map((f) => f.filename),
    };
  }

  refJson(repo: RepoRecord, ref: string, sha: string): Json {
    return {
      ref,
      node_id: this.nodeId("Ref", 0),
      url: this.api(`/repos/${repo.fullName}/git/${ref}`),
      object: {
        type: "commit",
        sha,
        url: this.api(`/repos/${repo.fullName}/git/commits/${sha}`),
      },
    };
  }

  branchJson(repo: RepoRecord, name: string, sha: string): Json {
    return {
      name,
      commit: { sha, url: this.api(`/repos/${repo.fullName}/commits/${sha}`) },
      protected: false,
    };
  }

  fileJson(
    repo: RepoRecord,
    path: string,
    ref: string,
    blob: { sha: string; size: number; content: Buffer } | null,
    type: "file" | "dir",
  ): Json {
    const base = `/repos/${repo.fullName}`;
    const name = path.split("/").pop() ?? path;
    const out: Json = {
      type,
      size: blob?.size ?? 0,
      name,
      path,
      sha: blob?.sha ?? "",
      url: this.api(`${base}/contents/${path}?ref=${encodeURIComponent(ref)}`),
      git_url: blob ? this.api(`${base}/git/blobs/${blob.sha}`) : null,
      html_url: this.api(`/${repo.fullName}/${type === "file" ? "blob" : "tree"}/${ref}/${path}`),
      download_url: type === "file" ? this.api(`/${repo.fullName}/raw/${ref}/${path}`) : null,
      _links: {
        self: this.api(`${base}/contents/${path}?ref=${encodeURIComponent(ref)}`),
        git: blob ? this.api(`${base}/git/blobs/${blob.sha}`) : null,
        html: this.api(`/${repo.fullName}/${type === "file" ? "blob" : "tree"}/${ref}/${path}`),
      },
    };
    if (type === "file" && blob) {
      out.content = blob.content.toString("base64");
      out.encoding = "base64";
    }
    return out;
  }
}
