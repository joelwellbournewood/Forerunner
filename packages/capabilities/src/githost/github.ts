import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";
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
 * GitHub REST adapter. Works against api.github.com, GitHub Enterprise and the fake git host in
 * testenv (same shapes). The token comes from the runtime (vault by reference); this class
 * never logs it. Rate limits are respected: on 403 with X-RateLimit-Remaining: 0 it waits for
 * the reset (bounded) and retries once; 5xx retries with backoff.
 */
export interface GitHubOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  userAgent?: string;
  /** Max seconds to wait for a rate-limit reset before giving up. Default 120. */
  maxRateLimitWaitSec?: number;
}

type Json = Record<string, unknown>;

export class GitHubHost implements GitHost {
  readonly kind = "github" as const;
  readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly clock: Clock;
  private readonly headers: Record<string, string>;
  private readonly maxWait: number;

  constructor(opts: GitHubOptions) {
    if (!opts.token) throw new ForerunnerError("provider_auth", "GitHub adapter needs a token");
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.f = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.maxWait = opts.maxRateLimitWaitSec ?? 120;
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
    opts: { raw?: Uint8Array; contentType?: string; allow404?: boolean } = {},
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.f(url, {
        method,
        headers: {
          ...this.headers,
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
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
    throw new ForerunnerError(
      "provider_error",
      `GitHub request failed after retries: ${method} ${path}`,
      { retryable: true },
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

  async listRepos(opts: { org?: string } = {}): Promise<RepoInfo[]> {
    const path = opts.org
      ? `/orgs/${encodeURIComponent(opts.org)}/repos?per_page=100`
      : "/user/repos?per_page=100&affiliation=owner,collaborator,organization_member";
    return (await this.request<Json[]>("GET", path)).map(toRepo);
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
    opts: { method?: "merge" | "squash" | "rebase"; title?: string } = {},
  ): Promise<{ merged: boolean; sha: string | null; message: string }> {
    try {
      const r = await this.request<Json>("PUT", `${this.repoPath(repo)}/pulls/${number}/merge`, {
        merge_method: opts.method ?? "squash",
        ...(opts.title ? { commit_title: opts.title } : {}),
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
    return toComment(
      await this.request<Json>("POST", `${this.repoPath(repo)}/issues/${number}/comments`, {
        body,
      }),
    );
  }

  async listPullRequestComments(repo: RepoRef, number: number): Promise<CommentInfo[]> {
    return (
      await this.request<Json[]>(
        "GET",
        `${this.repoPath(repo)}/issues/${number}/comments?per_page=100`,
      )
    ).map(toComment);
  }

  async reviewPullRequest(
    repo: RepoRef,
    number: number,
    opts: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
  ): Promise<{ id: number }> {
    const r = await this.request<Json>("POST", `${this.repoPath(repo)}/pulls/${number}/reviews`, {
      event: opts.event,
      body: opts.body,
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
    const r = await this.request<Json>(
      "POST",
      `${uploadUrl}?name=${encodeURIComponent(name)}`,
      undefined,
      { raw: data, contentType },
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
