import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";
import {
  buildSetFieldsMutation,
  DEFAULT_OPTION_COLOR,
  type FieldWrite,
  fieldKindOf,
  GQL_ADD_DRAFT,
  GQL_ARCHIVE_ITEM,
  GQL_CREATE_FIELD,
  GQL_CREATE_PROJECT,
  GQL_FIELDS,
  GQL_ITEMS,
  GQL_OWNER_PROJECTS,
  GQL_UNARCHIVE_ITEM,
  GQL_UPDATE_DRAFT,
  GQL_UPDATE_FIELD_OPTIONS,
  graphqlUrlFor,
} from "./github-graphql.ts";
import {
  type CheckRunInfo,
  type CommentInfo,
  type CommitStatusInfo,
  type FileContent,
  FORERUNNER_TASK_ID_FIELD,
  type GitHost,
  type IssueInfo,
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
 * GitHub REST adapter. Works against api.github.com, GitHub Enterprise and the fake git host in
 * testenv (same shapes). The token comes from the runtime (vault by reference); this class
 * never logs it. Rate limits are respected: on 403 with X-RateLimit-Remaining: 0 it waits for
 * the reset (bounded) and retries once; 5xx retries with backoff.
 */
export interface GitHubOptions {
  token: string;
  /**
   * Where the token lives (the vault), read before every request (U-049): a token replaced in
   * the app is used by the next call, without a restart. `token` is the one read at compose; a
   * source that answers nothing (or throws) leaves the last token in use.
   */
  tokenSource?: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  userAgent?: string;
  /** Max seconds to wait for a rate-limit reset before giving up. Default 120. */
  maxRateLimitWaitSec?: number;
  /** GraphQL endpoint (projects). Default: derived from baseUrl (`/graphql`, or `/api/graphql` on GHES). */
  graphqlUrl?: string;
  /** Items per page on list endpoints, 1 to 100 (GitHub's cap). Default 100. */
  pageSize?: number;
}

/** Bound on pages followed through `Link: rel="next"` (100 per page: 10,000 items). */
export const MAX_LIST_PAGES = 100;

/** The `next` URL of a GitHub `Link` header, or null when this was the last page. */
export function nextPageUrl(link: string | null | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

/** `scheme://host[:port]` of a URL, or null when the text is not one. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;

interface GraphqlError {
  type?: string;
  message?: string;
  path?: (string | number)[];
}

/** What the host remembers about one mirrored item, keyed by Forerunner task id. */
interface ItemRef {
  itemId: string;
  contentId: string | null;
  kind: ProjectItemInfo["kind"];
  title: string;
  body: string;
  archived: boolean;
  fields: ProjectItemFields;
}

export class GitHubHost implements GitHost {
  readonly kind = "github" as const;
  readonly baseUrl: string;
  readonly graphqlUrl: string;
  private readonly f: typeof fetch;
  private readonly clock: Clock;
  private readonly headers: Record<string, string>;
  private readonly maxWait: number;
  private readonly pageSize: number;
  /** `baseUrl`'s origin: the one place the token goes (null when `baseUrl` is not a URL). */
  private readonly origin: string | null;
  private readonly tokenSource: (() => Promise<string | null>) | undefined;
  /** projectId -> field name (lower case) -> field. */
  private readonly fieldCache = new Map<string, Map<string, ProjectFieldInfo>>();
  /** projectId -> Forerunner task id -> item. Filled by one listing, kept up to date by writes. */
  private readonly itemIndex = new Map<string, Map<string, ItemRef>>();
  /** projectId -> items without a Forerunner task id (issues humans added); never written to. */
  private readonly unindexed = new Map<string, ItemRef[]>();

  constructor(opts: GitHubOptions) {
    if (!opts.token) throw new ForerunnerError("provider_auth", "GitHub adapter needs a token");
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.graphqlUrl = opts.graphqlUrl ?? graphqlUrlFor(this.baseUrl);
    this.f = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.maxWait = opts.maxRateLimitWaitSec ?? 120;
    const pageSize = opts.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ForerunnerError("validation", "GitHub adapter: pageSize must be 1 to 100", {
        details: { pageSize },
      });
    }
    this.pageSize = pageSize;
    this.origin = originOf(this.baseUrl);
    this.tokenSource = opts.tokenSource;
    this.headers = {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": opts.userAgent ?? "forerunner",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: {
      raw?: Uint8Array;
      contentType?: string;
      allow404?: boolean;
      /** Sees the successful response before its body is read (pagination reads `Link`). */
      onResponse?: (res: Response) => void;
      /**
       * Lets an absolute URL on another origin through with the token. Only the release
       * upload (GitHub's own `upload_url`, `uploads.github.com`) says so; every other URL
       * the host hands out (a `Link` next page) must be on `baseUrl`'s origin, or the token
       * would follow whatever the host answers (ADR 0056, amendment of 2026-10-25).
       */
      otherOrigin?: boolean;
    } = {},
  ): Promise<T> {
    const absolute = path.startsWith("http");
    if (absolute && !opts.otherOrigin) this.assertOwnOrigin(path);
    const url = absolute ? path : `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.f(url, {
        method,
        headers: {
          ...(await this.currentHeaders()),
          ...(opts.raw
            ? { "Content-Type": opts.contentType ?? "application/octet-stream" }
            : body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
        },
        body: opts.raw
          ? (Buffer.from(opts.raw) as unknown as RequestInit["body"])
          : body !== undefined
            ? JSON.stringify(body)
            : undefined,
      });
      if (res.status === 404 && opts.allow404) return null as T;
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
        const waitMs = Math.max(0, reset - this.clock.now());
        if (attempt < 2 && waitMs <= this.maxWait * 1000) {
          await this.clock.sleep(waitMs + 50);
          continue;
        }
        throw new ForerunnerError("provider_rate_limit", "GitHub API rate limit exceeded", {
          retryable: true,
          details: { resetAt: new Date(reset).toISOString() },
        });
      }
      if (res.status >= 500 && attempt < 2) {
        await this.clock.sleep(250 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        let message = `${method} ${path} -> ${res.status}`;
        try {
          const j = (await res.json()) as { message?: string };
          if (j.message) message += `: ${j.message}`;
        } catch {
          // no body
        }
        const code =
          res.status === 401
            ? "provider_auth"
            : res.status === 403
              ? "tool_not_allowed"
              : res.status === 404
                ? "not_found"
                : res.status === 405 || res.status === 409 || res.status === 422
                  ? "validation"
                  : "provider_error";
        throw new ForerunnerError(code, message, { details: { status: res.status, path } });
      }
      opts.onResponse?.(res);
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
    throw new ForerunnerError(
      "provider_error",
      `GitHub request failed after retries: ${method} ${path}`,
      { retryable: true },
    );
  }

  /** The request headers with the token as it stands in the vault now (`tokenSource`). */
  private async currentHeaders(): Promise<Record<string, string>> {
    if (!this.tokenSource) return this.headers;
    const token = (await this.tokenSource().catch(() => null))?.trim();
    if (!token) return this.headers;
    this.headers.Authorization = `Bearer ${token}`;
    return this.headers;
  }

  /** A URL the host answered must be on `baseUrl`'s origin before the token is sent to it. */
  private assertOwnOrigin(url: string): void {
    const origin = originOf(url);
    if (origin !== null && this.origin !== null && origin === this.origin) return;
    throw new ForerunnerError(
      "provider_error",
      `GitHub answered with a URL on another origin (${origin ?? "unparsable"}); the token is only sent to ${this.origin ?? this.baseUrl}`,
      { details: { origin, expected: this.origin } },
    );
  }

  private repoPath(r: RepoRef): string {
    return `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
  }

  async whoAmI(): Promise<{ login: string }> {
    const u = await this.request<Json>("GET", "/user");
    return { login: String(u.login) };
  }

  async getRepo(repo: RepoRef): Promise<RepoInfo> {
    return toRepo(await this.request<Json>("GET", this.repoPath(repo)));
  }

  /**
   * Every page of a list endpoint: GitHub answers `per_page` items and names the next page in
   * the `Link` header; the walk stops at the last page or at `MAX_LIST_PAGES`.
   */
  private async paged<T>(firstPath: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = firstPath;
    for (let page = 0; next && page < MAX_LIST_PAGES; page++) {
      let link: string | null = null;
      const items = await this.request<T[]>("GET", next, undefined, {
        onResponse: (res) => {
          link = res.headers.get("link");
        },
      });
      out.push(...items);
      next = nextPageUrl(link);
    }
    return out;
  }

  async listRepos(opts: { org?: string; user?: string } = {}): Promise<RepoInfo[]> {
    const path = opts.org
      ? `/orgs/${encodeURIComponent(opts.org)}/repos?per_page=${this.pageSize}`
      : opts.user
        ? `/users/${encodeURIComponent(opts.user)}/repos?per_page=${this.pageSize}`
        : `/user/repos?per_page=${this.pageSize}&affiliation=owner,collaborator,organization_member`;
    return (await this.paged<Json>(path)).map(toRepo);
  }

  async createRepo(opts: {
    owner?: string;
    name: string;
    private: boolean;
    description?: string;
  }): Promise<RepoInfo> {
    const body = {
      name: opts.name,
      private: opts.private,
      description: opts.description ?? "",
      auto_init: true,
    };
    const r = opts.owner
      ? await this.request<Json>("POST", `/orgs/${encodeURIComponent(opts.owner)}/repos`, body)
      : await this.request<Json>("POST", "/user/repos", body);
    return toRepo(r);
  }

  async listBranches(repo: RepoRef): Promise<{ name: string; sha: string }[]> {
    const rows = await this.request<Json[]>("GET", `${this.repoPath(repo)}/branches?per_page=100`);
    return rows.map((b) => ({ name: String(b.name), sha: String((b.commit as Json)?.sha ?? "") }));
  }

  async getFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent | null> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const r = await this.request<Json | null>(
      "GET",
      `${this.repoPath(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}${q}`,
      undefined,
      { allow404: true },
    );
    if (r?.type !== "file") return null;
    const content = Buffer.from(String(r.content ?? ""), "base64").toString("utf8");
    return { path, sha: String(r.sha), content, encoding: "utf8" };
  }

  async putFile(
    repo: RepoRef,
    opts: { path: string; content: string; message: string; branch: string; sha?: string },
  ): Promise<{ sha: string }> {
    const r = await this.request<Json>(
      "PUT",
      `${this.repoPath(repo)}/contents/${opts.path.split("/").map(encodeURIComponent).join("/")}`,
      {
        message: opts.message,
        content: Buffer.from(opts.content, "utf8").toString("base64"),
        branch: opts.branch,
        ...(opts.sha ? { sha: opts.sha } : {}),
      },
    );
    return { sha: String((r.content as Json)?.sha ?? (r.commit as Json)?.sha ?? "") };
  }

  async createPullRequest(
    repo: RepoRef,
    opts: { title: string; body: string; head: string; base: string; draft?: boolean },
  ): Promise<PullRequestInfo> {
    return toPr(
      await this.request<Json>("POST", `${this.repoPath(repo)}/pulls`, {
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
        draft: opts.draft ?? false,
      }),
    );
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo> {
    return toPr(await this.request<Json>("GET", `${this.repoPath(repo)}/pulls/${number}`));
  }

  async listPullRequests(
    repo: RepoRef,
    opts: { state?: "open" | "closed" | "all"; head?: string } = {},
  ): Promise<PullRequestInfo[]> {
    const params = new URLSearchParams({ state: opts.state ?? "open", per_page: "100" });
    if (opts.head) params.set("head", opts.head);
    return (await this.request<Json[]>("GET", `${this.repoPath(repo)}/pulls?${params}`)).map(toPr);
  }

  async mergePullRequest(
    repo: RepoRef,
    number: number,
    opts: { method?: "merge" | "squash" | "rebase"; title?: string; sha?: string } = {},
  ): Promise<{ merged: boolean; sha: string | null; message: string }> {
    try {
      const r = await this.request<Json>("PUT", `${this.repoPath(repo)}/pulls/${number}/merge`, {
        merge_method: opts.method ?? "squash",
        ...(opts.title ? { commit_title: opts.title } : {}),
        ...(opts.sha ? { sha: opts.sha } : {}),
      });
      return {
        merged: Boolean(r.merged),
        sha: r.sha ? String(r.sha) : null,
        message: String(r.message ?? ""),
      };
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "validation")
        return { merged: false, sha: null, message: e.message };
      throw e;
    }
  }

  async commentOnPullRequest(repo: RepoRef, number: number, body: string): Promise<CommentInfo> {
    // Marked as the agent's (ADR 0075): the poller must not take its own comment for feedback.
    return toComment(
      await this.request<Json>("POST", `${this.repoPath(repo)}/issues/${number}/comments`, {
        body: markAgentText(body),
      }),
    );
  }

  async listPullRequestComments(
    repo: RepoRef,
    number: number,
    opts: { since?: string } = {},
  ): Promise<CommentInfo[]> {
    // Every page: GitHub lists the oldest first, so the first page alone never shows a new
    // comment once a PR has more than a page of them.
    const params = new URLSearchParams({ per_page: String(this.pageSize) });
    if (opts.since) params.set("since", opts.since);
    return (
      await this.paged<Json>(`${this.repoPath(repo)}/issues/${number}/comments?${params}`)
    ).map(toComment);
  }

  async listPullRequestReviews(repo: RepoRef, number: number): Promise<ReviewInfo[]> {
    return (
      await this.paged<Json>(
        `${this.repoPath(repo)}/pulls/${number}/reviews?per_page=${this.pageSize}`,
      )
    ).map(toReview);
  }

  async listPullRequestReviewComments(
    repo: RepoRef,
    number: number,
    opts: { since?: string } = {},
  ): Promise<ReviewCommentInfo[]> {
    const params = new URLSearchParams({
      per_page: String(this.pageSize),
      sort: "created",
      direction: "asc",
    });
    if (opts.since) params.set("since", opts.since);
    return (
      await this.paged<Json>(`${this.repoPath(repo)}/pulls/${number}/comments?${params}`)
    ).map(toReviewComment);
  }

  async reviewPullRequest(
    repo: RepoRef,
    number: number,
    opts: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
  ): Promise<{ id: number }> {
    const r = await this.request<Json>("POST", `${this.repoPath(repo)}/pulls/${number}/reviews`, {
      event: opts.event,
      body: markAgentText(opts.body),
    });
    return { id: Number(r.id) };
  }

  async createIssue(
    repo: RepoRef,
    opts: { title: string; body: string; labels?: string[] },
  ): Promise<IssueInfo> {
    return toIssue(
      await this.request<Json>("POST", `${this.repoPath(repo)}/issues`, {
        title: opts.title,
        body: opts.body,
        labels: opts.labels ?? [],
      }),
    );
  }

  async updateIssue(
    repo: RepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] },
  ): Promise<IssueInfo> {
    return toIssue(
      await this.request<Json>("PATCH", `${this.repoPath(repo)}/issues/${number}`, patch),
    );
  }

  async listIssues(
    repo: RepoRef,
    opts: { state?: "open" | "closed" | "all"; labels?: string[] } = {},
  ): Promise<IssueInfo[]> {
    const params = new URLSearchParams({ state: opts.state ?? "open", per_page: "100" });
    if (opts.labels?.length) params.set("labels", opts.labels.join(","));
    const rows = await this.request<Json[]>("GET", `${this.repoPath(repo)}/issues?${params}`);
    return rows.filter((r) => !r.pull_request).map(toIssue);
  }

  async commentOnIssue(repo: RepoRef, number: number, body: string): Promise<CommentInfo> {
    return this.commentOnPullRequest(repo, number, body);
  }

  async listCheckRuns(repo: RepoRef, ref: string): Promise<CheckRunInfo[]> {
    const r = await this.request<Json>(
      "GET",
      `${this.repoPath(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    );
    return ((r.check_runs as Json[]) ?? []).map((c) => ({
      id: Number(c.id),
      name: String(c.name),
      status: c.status as CheckRunInfo["status"],
      conclusion: (c.conclusion as CheckRunInfo["conclusion"]) ?? null,
      detailsUrl: c.details_url ? String(c.details_url) : null,
    }));
  }

  async listCommitStatuses(repo: RepoRef, ref: string): Promise<CommitStatusInfo[]> {
    // The combined status holds the latest status per context (the list endpoint every one).
    const r = await this.request<Json>(
      "GET",
      `${this.repoPath(repo)}/commits/${encodeURIComponent(ref)}/status?per_page=100`,
    );
    return ((r.statuses as Json[]) ?? []).map((s) => ({
      id: Number(s.id),
      context: String(s.context ?? "default"),
      state: s.state as CommitStatusInfo["state"],
      targetUrl: s.target_url ? String(s.target_url) : null,
    }));
  }

  async createRelease(
    repo: RepoRef,
    opts: { tagName: string; name: string; body: string; draft?: boolean; prerelease?: boolean },
  ): Promise<ReleaseInfo> {
    return toRelease(
      await this.request<Json>("POST", `${this.repoPath(repo)}/releases`, {
        tag_name: opts.tagName,
        name: opts.name,
        body: opts.body,
        draft: opts.draft ?? false,
        prerelease: opts.prerelease ?? false,
      }),
    );
  }

  async uploadReleaseAsset(
    repo: RepoRef,
    releaseId: number,
    name: string,
    data: Uint8Array,
    contentType = "application/octet-stream",
  ): Promise<{ name: string; downloadUrl: string }> {
    const rel = await this.request<Json>("GET", `${this.repoPath(repo)}/releases/${releaseId}`);
    const uploadUrl = String(
      rel.upload_url ??
        `${this.baseUrl}${this.repoPath(repo)}/releases/${releaseId}/assets{?name,label}`,
    ).replace(/\{[^}]*\}$/, "");
    // The upload origin GitHub hands out (`uploads.github.com` on github.com; the API host
    // itself on GHES): the one URL from the host that may carry the token off `baseUrl`.
    const r = await this.request<Json>(
      "POST",
      `${uploadUrl}?name=${encodeURIComponent(name)}`,
      undefined,
      { raw: data, contentType, otherOrigin: true },
    );
    return { name: String(r.name ?? name), downloadUrl: String(r.browser_download_url ?? "") };
  }

  async getLatestRelease(repo: RepoRef): Promise<ReleaseInfo | null> {
    const r = await this.request<Json | null>(
      "GET",
      `${this.repoPath(repo)}/releases/latest`,
      undefined,
      { allow404: true },
    );
    return r ? toRelease(r) : null;
  }

  async rateLimit(): Promise<{ limit: number; remaining: number; resetAt: string }> {
    const r = await this.request<Json>("GET", "/rate_limit");
    const core = ((r.resources as Json)?.core ?? r.rate ?? {}) as Json;
    return {
      limit: Number(core.limit ?? 0),
      remaining: Number(core.remaining ?? 0),
      resetAt: new Date(Number(core.reset ?? 0) * 1000).toISOString(),
    };
  }

  // ---- GraphQL transport (projects) --------------------------------------------------------

  /** How long a rate-limited response asks us to wait, or null when it is not a rate limit. */
  private rateLimitWaitMs(res: Response): number | null {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter !== null && /^\d+$/.test(retryAfter.trim()))
      return Number(retryAfter.trim()) * 1000;
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      return Math.max(0, reset - this.clock.now());
    }
    return null;
  }

  /**
   * POST a GraphQL document. Rate limits (429, 403 with Retry-After or an exhausted
   * X-RateLimit, and RATE_LIMITED errors in a 200 body) wait for the announced time
   * (bounded by maxRateLimitWaitSec) and retry; 5xx retries with backoff; GraphQL errors map
   * to ForerunnerError codes. The token is only ever a header: never part of an error.
   */
  async graphql<T extends Json>(query: string, variables: Record<string, unknown>): Promise<T> {
    const opName = /^\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)?.[1] ?? "anonymous";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.f(this.graphqlUrl, {
        method: "POST",
        headers: { ...(await this.currentHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables, operationName: opName }),
      });
      if (res.status === 429 || res.status === 403) {
        const waitMs = this.rateLimitWaitMs(res);
        if (waitMs !== null) {
          if (attempt < 2 && waitMs <= this.maxWait * 1000) {
            await this.clock.sleep(waitMs + 50);
            continue;
          }
          throw new ForerunnerError("provider_rate_limit", "GitHub GraphQL rate limit exceeded", {
            retryable: true,
            details: { operation: opName, retryAfterMs: waitMs },
          });
        }
      }
      if (res.status >= 500 && attempt < 2) {
        await this.clock.sleep(250 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        let message = `graphql ${opName} -> ${res.status}`;
        try {
          const j = (await res.json()) as { message?: string };
          if (j.message) message += `: ${j.message}`;
        } catch {
          // no body
        }
        const code =
          res.status === 401
            ? "provider_auth"
            : res.status === 403
              ? "tool_not_allowed"
              : res.status === 404
                ? "not_found"
                : "provider_error";
        throw new ForerunnerError(code, message, {
          details: { status: res.status, operation: opName },
        });
      }
      const payload = (await res.json()) as { data?: T; errors?: GraphqlError[] };
      const errors = payload.errors ?? [];
      if (errors.length) {
        const types = errors.map((e) => String(e.type ?? ""));
        if (types.includes("RATE_LIMITED")) {
          const waitMs = this.rateLimitWaitMs(res) ?? 60_000;
          if (attempt < 2 && waitMs <= this.maxWait * 1000) {
            await this.clock.sleep(waitMs + 50);
            continue;
          }
          throw new ForerunnerError("provider_rate_limit", "GitHub GraphQL rate limit exceeded", {
            retryable: true,
            details: { operation: opName, retryAfterMs: waitMs },
          });
        }
        const message = `graphql ${opName}: ${errors.map((e) => e.message ?? e.type ?? "error").join("; ")}`;
        const code = types.includes("NOT_FOUND")
          ? "not_found"
          : types.includes("FORBIDDEN") || types.includes("INSUFFICIENT_SCOPES")
            ? "tool_not_allowed"
            : types.includes("UNPROCESSABLE")
              ? "validation"
              : "provider_error";
        throw new ForerunnerError(code, message, { details: { operation: opName, types } });
      }
      if (!payload.data) {
        throw new ForerunnerError("provider_error", `graphql ${opName}: empty response`, {
          retryable: true,
        });
      }
      return payload.data;
    }
    throw new ForerunnerError("provider_error", `GitHub GraphQL failed after retries: ${opName}`, {
      retryable: true,
    });
  }

  // ---- projects ------------------------------------------------------------------------------

  async ensureProject(owner: string, title: string): Promise<ProjectInfo> {
    const found = await this.graphql<{
      repositoryOwner: { id: string; projectsV2?: { nodes: Json[] } } | null;
    }>(GQL_OWNER_PROJECTS, { login: owner, query: title });
    const ownerNode = found.repositoryOwner;
    if (!ownerNode) throw new ForerunnerError("not_found", `GitHub owner ${owner} not found`);
    const existing = (ownerNode.projectsV2?.nodes ?? [])
      .map(toProject)
      .find((p) => p.title === title && !p.closed);
    if (existing) return existing;
    const created = await this.graphql<{ createProjectV2: { projectV2: Json } }>(
      GQL_CREATE_PROJECT,
      { ownerId: ownerNode.id, title },
    );
    return toProject(created.createProjectV2.projectV2);
  }

  private async loadFields(projectId: string): Promise<Map<string, ProjectFieldInfo>> {
    const r = await this.graphql<{ node: { fields?: { nodes: Json[] } } | null }>(GQL_FIELDS, {
      projectId,
    });
    if (!r.node) throw new ForerunnerError("not_found", `GitHub project ${projectId} not found`);
    const map = new Map<string, ProjectFieldInfo>();
    for (const n of r.node.fields?.nodes ?? []) {
      if (!n.id) continue;
      map.set(String(n.name).toLowerCase(), {
        id: String(n.id),
        name: String(n.name),
        kind: fieldKindOf(n.dataType),
        options: ((n.options as Json[]) ?? []).map((o) => ({
          id: String(o.id),
          name: String(o.name),
        })),
      });
    }
    this.fieldCache.set(projectId, map);
    return map;
  }

  private async fields(projectId: string): Promise<Map<string, ProjectFieldInfo>> {
    return this.fieldCache.get(projectId) ?? this.loadFields(projectId);
  }

  async ensureFields(projectId: string, specs: ProjectFieldSpec[]): Promise<ProjectFieldInfo[]> {
    let fields = await this.loadFields(projectId);
    let changed = false;
    for (const spec of specs) {
      const current = fields.get(spec.name.toLowerCase());
      const options = (spec.options ?? []).map((o) => ({
        name: o.name,
        color: o.color ?? DEFAULT_OPTION_COLOR,
        description: o.description ?? "",
      }));
      if (!current) {
        await this.graphql(GQL_CREATE_FIELD, {
          projectId,
          name: spec.name,
          dataType: spec.kind === "single_select" ? "SINGLE_SELECT" : "TEXT",
          options: spec.kind === "single_select" ? options : null,
        });
        changed = true;
        continue;
      }
      if (spec.kind === "single_select") {
        if (current.kind !== "single_select") {
          throw new ForerunnerError(
            "validation",
            `project field "${current.name}" exists with type ${current.kind}, expected single_select`,
          );
        }
        const have = new Set(current.options.map((o) => o.name.toLowerCase()));
        const missing = options.filter((o) => !have.has(o.name.toLowerCase()));
        if (missing.length) {
          // Existing options keep their ids (and the items that use them); new ones are appended.
          const merged = [
            ...current.options.map((o) => {
              const spec = options.find((s) => s.name.toLowerCase() === o.name.toLowerCase());
              return {
                name: o.name,
                color: spec?.color ?? DEFAULT_OPTION_COLOR,
                description: spec?.description ?? "",
              };
            }),
            ...missing,
          ];
          await this.graphql(GQL_UPDATE_FIELD_OPTIONS, { fieldId: current.id, options: merged });
          changed = true;
        }
      } else if (current.kind !== "text") {
        throw new ForerunnerError(
          "validation",
          `project field "${current.name}" exists with type ${current.kind}, expected text`,
        );
      }
    }
    if (changed) fields = await this.loadFields(projectId);
    return [...fields.values()];
  }

  private async loadItems(projectId: string): Promise<Map<string, ItemRef>> {
    const index = new Map<string, ItemRef>();
    const all: ItemRef[] = [];
    let after: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const r: { node: { items?: { pageInfo: Json; nodes: Json[] } } | null } = await this.graphql(
        GQL_ITEMS,
        { projectId, after },
      );
      if (!r.node) throw new ForerunnerError("not_found", `GitHub project ${projectId} not found`);
      for (const n of r.node.items?.nodes ?? []) all.push(toItemRef(n));
      const info = r.node.items?.pageInfo ?? {};
      if (!info.hasNextPage) break;
      after = String(info.endCursor ?? "");
      if (!after) break;
    }
    for (const ref of all) {
      const tid = ref.fields[FORERUNNER_TASK_ID_FIELD];
      if (tid) index.set(tid, ref);
    }
    this.itemIndex.set(projectId, index);
    this.unindexed.set(
      projectId,
      all.filter((i) => !i.fields[FORERUNNER_TASK_ID_FIELD]),
    );
    return index;
  }

  private async items(projectId: string): Promise<Map<string, ItemRef>> {
    return this.itemIndex.get(projectId) ?? this.loadItems(projectId);
  }

  async listProjectItems(projectId: string): Promise<ProjectItemInfo[]> {
    const index = await this.loadItems(projectId);
    return [...index.values(), ...(this.unindexed.get(projectId) ?? [])].map(toItemInfo);
  }

  async findItem(projectId: string, forerunnerTaskId: string): Promise<ProjectItemInfo | null> {
    const ref = (await this.items(projectId)).get(forerunnerTaskId);
    return ref ? toItemInfo(ref) : null;
  }

  async upsertItem(projectId: string, input: ProjectItemInput): Promise<UpsertItemResult> {
    const index = await this.items(projectId);
    const body = input.body ?? "";
    let ref = index.get(input.forerunnerTaskId);
    let created = false;
    let fields: ProjectItemFields = { ...(input.fields ?? {}) };
    if (!ref) {
      const r = await this.graphql<{
        addProjectV2DraftIssue: { projectItem: { id: string; content?: { id?: string } | null } };
      }>(GQL_ADD_DRAFT, { projectId, title: input.title, body });
      ref = {
        itemId: r.addProjectV2DraftIssue.projectItem.id,
        contentId: r.addProjectV2DraftIssue.projectItem.content?.id ?? null,
        kind: "draft",
        title: input.title,
        body,
        archived: false,
        fields: {},
      };
      index.set(input.forerunnerTaskId, ref);
      created = true;
      fields = { [FORERUNNER_TASK_ID_FIELD]: input.forerunnerTaskId, ...fields };
    } else {
      if (ref.archived) {
        await this.graphql(GQL_UNARCHIVE_ITEM, { projectId, itemId: ref.itemId });
        ref.archived = false;
      }
      if (
        ref.kind === "draft" &&
        ref.contentId &&
        (ref.title !== input.title || ref.body !== body)
      ) {
        await this.graphql(GQL_UPDATE_DRAFT, {
          draftIssueId: ref.contentId,
          title: input.title,
          body,
        });
        ref.title = input.title;
        ref.body = body;
      }
      // Only send values that differ from what the host holds (cheap repeated runs).
      for (const [k, v] of Object.entries(fields)) {
        if ((ref.fields[k] ?? null) === (v ?? null)) delete fields[k];
      }
    }
    if (Object.keys(fields).length) await this.setItemFields(projectId, ref.itemId, fields);
    return { item: toItemInfo(ref), created };
  }

  async setItemFields(projectId: string, itemId: string, values: ProjectItemFields): Promise<void> {
    const fields = await this.fields(projectId);
    const writes: FieldWrite[] = [];
    for (const [name, value] of Object.entries(values)) {
      const field = fields.get(name.toLowerCase());
      if (!field) {
        throw new ForerunnerError("validation", `project field "${name}" does not exist`, {
          details: { projectId, field: name },
        });
      }
      if (value === null) {
        writes.push({ fieldId: field.id, value: null });
      } else if (field.kind === "single_select") {
        const option = field.options.find((o) => o.name.toLowerCase() === value.toLowerCase());
        if (!option) {
          throw new ForerunnerError(
            "validation",
            `project field "${field.name}" has no option "${value}"`,
            { details: { projectId, field: field.name, value } },
          );
        }
        writes.push({ fieldId: field.id, value: { singleSelectOptionId: option.id } });
      } else if (field.kind === "text") {
        writes.push({ fieldId: field.id, value: { text: value } });
      } else {
        throw new ForerunnerError(
          "validation",
          `project field "${field.name}" is ${field.kind}; the mirror writes text and single-select fields only`,
        );
      }
    }
    if (!writes.length) return;
    const m = buildSetFieldsMutation(writes);
    await this.graphql(m.query, { ...m.variables, projectId, itemId });
    const ref = [...(this.itemIndex.get(projectId) ?? new Map<string, ItemRef>()).values()].find(
      (i) => i.itemId === itemId,
    );
    if (ref) {
      for (const [k, v] of Object.entries(values)) {
        const canonical = fields.get(k.toLowerCase())?.name ?? k;
        if (v === null) delete ref.fields[canonical];
        else ref.fields[canonical] = v;
      }
    }
  }

  async archiveItem(projectId: string, itemId: string): Promise<void> {
    await this.graphql(GQL_ARCHIVE_ITEM, { projectId, itemId });
    const ref = [...(this.itemIndex.get(projectId) ?? new Map<string, ItemRef>()).values()].find(
      (i) => i.itemId === itemId,
    );
    if (ref) ref.archived = true;
  }
}

function toProject(r: Json): ProjectInfo {
  return {
    id: String(r.id),
    number: Number(r.number ?? 0),
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    closed: Boolean(r.closed),
  };
}

function toItemRef(n: Json): ItemRef {
  const content = (n.content as Json | null) ?? null;
  const typename = String(content?.__typename ?? "");
  const kind: ProjectItemInfo["kind"] =
    typename === "DraftIssue"
      ? "draft"
      : typename === "Issue"
        ? "issue"
        : typename === "PullRequest"
          ? "pull_request"
          : "other";
  const fields: ProjectItemFields = {};
  for (const fv of ((n.fieldValues as Json)?.nodes as Json[]) ?? []) {
    const name = (fv.field as Json)?.name;
    if (!name) continue;
    if (typeof fv.text === "string") fields[String(name)] = fv.text;
    else if (typeof fv.name === "string") fields[String(name)] = fv.name;
  }
  return {
    itemId: String(n.id),
    contentId: content?.id ? String(content.id) : null,
    kind,
    title: String(content?.title ?? ""),
    body: String(content?.body ?? ""),
    archived: Boolean(n.isArchived),
    fields,
  };
}

function toItemInfo(ref: ItemRef): ProjectItemInfo {
  return {
    id: ref.itemId,
    forerunnerTaskId: ref.fields[FORERUNNER_TASK_ID_FIELD] ?? null,
    title: ref.title,
    body: ref.body,
    archived: ref.archived,
    fields: { ...ref.fields },
    kind: ref.kind,
  };
}

function toRepo(r: Json): RepoInfo {
  const owner = (r.owner as Json)?.login
    ? String((r.owner as Json).login)
    : (String(r.full_name ?? "").split("/")[0] ?? "");
  const perms = r.permissions as Json | undefined;
  return {
    owner,
    name: String(r.name),
    fullName: String(r.full_name ?? `${owner}/${r.name}`),
    defaultBranch: String(r.default_branch ?? "main"),
    private: Boolean(r.private),
    htmlUrl: String(r.html_url ?? ""),
    cloneUrl: String(r.clone_url ?? ""),
    permissions: perms
      ? { pull: Boolean(perms.pull), push: Boolean(perms.push), admin: Boolean(perms.admin) }
      : undefined,
  };
}

function toPr(r: Json): PullRequestInfo {
  return {
    number: Number(r.number),
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    state: r.state === "closed" ? "closed" : "open",
    merged: Boolean(r.merged ?? r.merged_at),
    mergeable: typeof r.mergeable === "boolean" ? r.mergeable : null,
    head: { ref: String((r.head as Json)?.ref ?? ""), sha: String((r.head as Json)?.sha ?? "") },
    base: { ref: String((r.base as Json)?.ref ?? ""), sha: String((r.base as Json)?.sha ?? "") },
    htmlUrl: String(r.html_url ?? ""),
    draft: Boolean(r.draft),
  };
}

function toIssue(r: Json): IssueInfo {
  return {
    number: Number(r.number),
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    state: r.state === "closed" ? "closed" : "open",
    labels: ((r.labels as (Json | string)[]) ?? []).map((l) =>
      typeof l === "string" ? l : String(l.name),
    ),
    htmlUrl: String(r.html_url ?? ""),
  };
}

function toComment(r: Json): CommentInfo {
  return {
    id: Number(r.id),
    body: String(r.body ?? ""),
    author: String((r.user as Json)?.login ?? ""),
    createdAt: String(r.created_at ?? ""),
    htmlUrl: String(r.html_url ?? ""),
  };
}

function toReviewComment(r: Json): ReviewCommentInfo {
  const line = r.line ?? r.original_line;
  return {
    ...toComment(r),
    reviewId: r.pull_request_review_id == null ? null : Number(r.pull_request_review_id),
    path: String(r.path ?? ""),
    line: typeof line === "number" ? line : null,
    inReplyTo: r.in_reply_to_id == null ? null : Number(r.in_reply_to_id),
  };
}

const REVIEW_STATES: ReadonlySet<string> = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);

function toReview(r: Json): ReviewInfo {
  const state = String(r.state ?? "COMMENTED");
  return {
    id: Number(r.id),
    body: String(r.body ?? ""),
    author: String((r.user as Json)?.login ?? ""),
    state: (REVIEW_STATES.has(state) ? state : "COMMENTED") as ReviewInfo["state"],
    submittedAt: r.submitted_at ? String(r.submitted_at) : null,
    htmlUrl: String(r.html_url ?? ""),
  };
}

function toRelease(r: Json): ReleaseInfo {
  return {
    id: Number(r.id),
    tagName: String(r.tag_name ?? ""),
    name: String(r.name ?? ""),
    body: String(r.body ?? ""),
    draft: Boolean(r.draft),
    prerelease: Boolean(r.prerelease),
    htmlUrl: String(r.html_url ?? ""),
    assets: ((r.assets as Json[]) ?? []).map((a) => ({
      name: String(a.name),
      size: Number(a.size ?? 0),
      downloadUrl: String(a.browser_download_url ?? ""),
    })),
  };
}
