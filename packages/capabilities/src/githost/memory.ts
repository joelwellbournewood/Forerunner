import { ForerunnerError } from "@forerunner/platform";
import {
  type CheckRunInfo,
  type CommentInfo,
  type FileContent,
  FORERUNNER_TASK_ID_FIELD,
  type GitHost,
  type IssueInfo,
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
  checks: Map<string, CheckRunInfo[]>;
  releases: ReleaseInfo[];
  nextNumber: number;
}

interface MemoryProject extends ProjectInfo {
  owner: string;
  fields: ProjectFieldInfo[];
  items: MemoryItem[];
}

interface MemoryItem extends ProjectItemInfo {
  projectId: string;
}

export class MemoryGitHost implements GitHost {
  readonly kind = "github" as const;
  readonly baseUrl = "memory://";
  readonly login: string;
  private repos = new Map<string, Repo>();
  private readonly projects = new Map<string, MemoryProject>();
  private nextId = 1;
  mergeableByDefault = true;
  /** Every project call, in order (tests assert how many outward calls a sync made). */
  readonly projectCalls: { op: string; projectId?: string; detail?: string }[] = [];

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

  // ---- projects ------------------------------------------------------------------------------

  private project(id: string): MemoryProject {
    const p = this.projects.get(id);
    if (!p) throw new ForerunnerError("not_found", `project ${id} not found`);
    return p;
  }

  async ensureProject(owner: string, title: string): Promise<ProjectInfo> {
    this.projectCalls.push({ op: "ensureProject", detail: `${owner}:${title}` });
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
