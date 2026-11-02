import { existsSync, mkdirSync } from "node:fs";
import {
  ensureBaseBranch,
  ensureWorkspaceGitignore,
  type GitHost,
  GitOps,
  type GitTokenSource,
  gitAuthFor,
  type RepoRef,
  resolveGitToken,
  WORKSPACE_IDENTITY,
} from "@forerunner/capabilities";
import {
  STATUS_DOC,
  type StatusLists,
  type StatusUpdate,
  scaffoldDocs,
  writeStatusUpdate,
} from "@forerunner/memory";
import { type Clock, errorMessage, isAbsolute, join, log, safeSegment } from "@forerunner/platform";
import type { ProjectRow, SessionRow, StateStore, TaskRow } from "@forerunner/state";
import { type InstallMarkerWrite, writeInstallMarker } from "../sources/marker.ts";
import type {
  DocsScaffoldOutcome,
  ProjectDocsPort,
  SessionStatusOutcome,
  SessionStatusUpdate,
} from "./ports.ts";

/**
 * The PM keeps the standard project doc set current (spec G.5; ADR 0058). The eight docs
 * live in the project's repository: at project creation the missing ones are scaffolded on
 * a branch and opened as a pull request, and at session end the runner's status update is
 * committed to `docs/status.md` on Forerunner's own status branch (`STATUS_BRANCH`) with one
 * pull request at a time. Never on a task's pull request branch (ADR 0106): the critic had
 * accepted that branch, and a status commit pushed onto it after the review put a file the
 * critic never saw into a reviewed PR (GitHub walk, 2026-11-02). The default branch is never
 * pushed, except for the first commit of an empty repository (`ensureBaseBranch`, ADR 0106):
 * the doc set goes in as that commit. An existing file is never overwritten (`scaffoldDocs`
 * skips what is there, whatever the branch already carries). The scaffold also writes the
 * install marker `.forerunner/project.json` (spec A.4, ADR 0056) beside the set, never over
 * another project's. After each write the docs clone is back on the default branch, so the
 * Docs tab, the Files tab and the chat read what is merged, and `docsInPullRequests` names the
 * docs still waiting in a pull request. A project without a repository keeps the set under
 * `<projectsRoot>/<project id>/workspace`, where the session's work is committed with the
 * status update at session end. The critic's drift check (`checkDocDrift`) reads the same files.
 */
export const DOCS_SCAFFOLD_BRANCH = "fr/docs-scaffold";

/** Forerunner's branch for `docs/status.md` in a repository: one pull request at a time. */
export const STATUS_BRANCH = "fr/status";

/** The branches Forerunner keeps the project's docs on (scaffold, the intake's set, status). */
export function isDocsBranch(branch: string): boolean {
  return (
    branch === DOCS_SCAFFOLD_BRANCH ||
    branch === STATUS_BRANCH ||
    /^fr\/intake-[^/]+-docs$/.test(branch)
  );
}

/** A doc of the set that is not on the default branch yet: the pull request it waits in. */
export interface DocInPullRequest {
  path: string;
  number: number;
  url: string;
}

/** Directory under the project's data root holding the doc set of a project without a repo. */
export const WORKSPACE_DIR = "workspace";

/**
 * `<projectsRoot>/<project id>/workspace`: the folder of a project without a repository, where
 * the intake and the doc scaffold write the docs and where its tasks run (U-037).
 */
export function projectWorkspaceDir(projectsRoot: string, projectId: string): string {
  return join(projectsRoot, safeSegment(projectId, "project"), WORKSPACE_DIR);
}

/** How many tasks each top section of `docs/status.md` lists from the project's state. */
export const STATUS_STATE_LIMIT = 15;

export interface ProjectRepoTarget {
  clone: string;
  repo: RepoRef;
  base: string;
}

export interface ProjectDocsDeps {
  store: StateStore;
  clock: Clock;
  host: GitHost;
  /** The project's first repository: clone URL, owner/name, default branch; null without one. */
  repoFor: (project: ProjectRow) => Promise<ProjectRepoTarget | null>;
  /** Clones for the docs commits live at `<worktreeRoot>/<project id>`. */
  worktreeRoot: string;
  /** Projects without a repository keep their docs under `<projectsRoot>/<project id>/workspace`. */
  projectsRoot: string;
  /** The person's token, or a function that reads it for each commit (U-082). */
  token?: GitTokenSource;
  identity?: { name: string; email: string };
}

/**
 * `owner/name`, or a clone URL (`https://host/owner/name[.git]`, `git@host:owner/name[.git]`),
 * as a repository reference; null when the text names no owner and name.
 */
export function parseRepoRef(text: string): RepoRef | null {
  const t = text.trim();
  if (!t) return null;
  const plain = /^([\w.-]+)\/([\w.-]+)$/.exec(t);
  if (plain?.[1] && plain[2]) return { owner: plain[1], name: plain[2].replace(/\.git$/, "") };
  const path = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+\/|[\w.-]+@[\w.-]+:)(.+)$/i.exec(t)?.[1];
  if (!path) return null;
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  const name = parts.at(-1)?.replace(/\.git$/, "");
  const owner = parts.at(-2);
  if (!owner || !name) return null;
  return { owner, name };
}

/**
 * The token for the docs clone, scoped to the repository's origin (ADR 0069, the rule the A.3
 * import applies). Moved to `@forerunner/capabilities` so every GitOps caller shares it;
 * re-exported here for existing importers.
 */
export { gitAuthFor };

export class ProjectDocs implements ProjectDocsPort {
  private readonly logger = log("project-docs");

  constructor(private readonly deps: ProjectDocsDeps) {}

  /** `<projectsRoot>/<project id>/workspace`: the doc set of a project without a repository. */
  workspaceDir(projectId: string): string {
    return join(this.deps.projectsRoot, safeSegment(projectId, "project"), WORKSPACE_DIR);
  }

  /**
   * Where the chat's docs search reads a project's doc set (spec J.1, ADR 0061), in order,
   * without cloning or fetching anything: a local folder the project is linked to (an absolute
   * `repos[0]`, spec A.4: the human's own docs), this install's docs clone of its repository
   * (`<worktreeRoot>/<project id>`, kept by the scaffold and the status updates), and the
   * data-dir workspace, where G.5 writes the set of a project without a host repository, a
   * linked folder's project included (`parseRepoRef` is null for a path; review finding 4).
   * Only the roots that exist; empty when none does yet. The search lets the first root win
   * on the same repo-relative path.
   */
  docsDirsFor(project: ProjectRow): string[] {
    const out: string[] = [];
    const linked = project.repos[0]?.trim();
    if (linked && isAbsolute(linked) && existsSync(linked)) out.push(linked);
    const clone = join(this.deps.worktreeRoot, safeSegment(project.id, "project"));
    if (existsSync(join(clone, ".git"))) out.push(clone);
    const workspace = this.workspaceDir(project.id);
    if (existsSync(workspace)) out.push(workspace);
    return out;
  }

  async scaffoldProject(project: ProjectRow): Promise<DocsScaffoldOutcome> {
    const info = { name: project.name, goal: project.goal, repos: project.repos };
    let outcome: DocsScaffoldOutcome;
    try {
      const target = await this.deps.repoFor(project);
      if (!target) {
        const dir = this.workspaceDir(project.id);
        mkdirSync(dir, { recursive: true });
        const res = await scaffoldDocs(dir, info);
        const marker = await this.mark(project, dir);
        outcome = {
          location: "data_dir",
          dir,
          created: res.created,
          existing: res.existing,
          marker,
        };
      } else {
        const branch = DOCS_SCAFFOLD_BRANCH;
        const { git, dir, existingPr, first } = await this.checkout(project, target, branch);
        if (first) {
          // An empty repository: the set went in as its first commit on the default branch.
          outcome = {
            location: "repo",
            branch: target.base,
            prUrl: null,
            created: first.created,
            existing: [],
            ...(first.marker ? { marker: first.marker } : {}),
            firstCommit: true,
          };
          await this.backToBase(git, target);
        } else {
          const res = await scaffoldDocs(dir, info);
          const marker = await this.mark(project, dir);
          let prUrl = existingPr?.htmlUrl ?? null;
          const written = [...res.created, ...(marker.status === "created" ? [marker.path] : [])];
          if (written.length) {
            const list = written.map((p) => `- ${p}`).join("\n");
            const markerNote =
              marker.status === "created"
                ? `\n\n\`${marker.path}\` marks the repository as managed by a Forerunner project (spec A.4); a source scan by any install reads it.`
                : "";
            await git.commitAll(`docs: scaffold the standard doc set\n\n${list}`);
            await git.push(branch, { defaultBranch: target.base });
            if (existingPr) {
              await this.deps.host.commentOnPullRequest(
                target.repo,
                existingPr.number,
                `Added the missing standard docs for project ${project.name}:\n${list}${markerNote}`,
              );
            } else {
              const pr = await this.deps.host.createPullRequest(target.repo, {
                title: "docs: scaffold the standard project doc set",
                body: `Standard project docs for ${project.name} (spec G.5), written from templates for the files the repository lacked:\n${list}${markerNote}\n\nExisting files were left as they are${res.existing.length ? ` (${res.existing.join(", ")})` : ""}. Opened by Forerunner.`,
                head: branch,
                base: target.base,
              });
              prUrl = pr.htmlUrl;
            }
          }
          await this.backToBase(git, target);
          outcome = {
            location: "repo",
            branch,
            prUrl,
            created: res.created,
            existing: res.existing,
            marker,
          };
        }
      }
    } catch (e) {
      // Project creation never fails on the docs: the gap is recorded on the project and
      // the critic's drift check reports the missing docs at the first review.
      const error = errorMessage(e);
      this.logger.warn("doc scaffold failed", { projectId: project.id, error });
      await this.record(project, { error, failed_at: this.deps.clock.nowIso() });
      throw e;
    }
    await this.record(project, {
      location: outcome.location,
      ...(outcome.branch ? { branch: outcome.branch } : {}),
      ...(outcome.prUrl !== undefined ? { pr_url: outcome.prUrl } : {}),
      ...(outcome.dir ? { dir: outcome.dir } : {}),
      created: outcome.created,
      existing: outcome.existing,
      ...(outcome.marker ? { marker: outcome.marker } : {}),
      ...(outcome.firstCommit ? { first_commit: true } : {}),
      scaffolded_at: this.deps.clock.nowIso(),
    });
    this.logger.info("standard docs scaffolded", {
      projectId: project.id,
      location: outcome.location,
      created: outcome.created.length,
      prUrl: outcome.prUrl ?? null,
      firstCommit: outcome.firstCommit ?? false,
    });
    return outcome;
  }

  async writeSessionStatus(input: {
    project: ProjectRow;
    session: SessionRow;
    update: SessionStatusUpdate;
  }): Promise<SessionStatusOutcome> {
    const { project, session } = input;
    const update: StatusUpdate = { ...input.update, state: await this.projectState(project.id) };
    const target = await this.deps.repoFor(project);
    if (!target) return this.statusInFolder(project, session, update);
    // Forerunner's own status branch, never a task's: the critic accepted the task's branch,
    // and a commit after the review would put a file it never saw into the reviewed PR.
    const branch = STATUS_BRANCH;
    const { git, dir, existingPr } = await this.checkout(project, target, branch, {
      // A status PR that was merged or closed: the branch starts again from the default one.
      fresh: async (open) => !open,
    });
    const res = await writeStatusUpdate(dir, update);
    const commit = await git.commitAll(`docs: status after session ${session.id}`);
    let prUrl = existingPr?.htmlUrl ?? null;
    if (commit.committed) {
      // The branch is Forerunner's alone; without an open PR it was started again from the
      // default branch, so the host's old copy (a merged or closed PR's) is replaced.
      await git.push(branch, { force: !existingPr, defaultBranch: target.base });
      const body = `Status update of session ${session.id} (${update.endedAt}):\n\n- Done: ${line(update.done)}\n- In flight: ${line(update.inFlight)}\n- Blocked: ${line(update.blocked)}\n- Next: ${line(update.next)}`;
      if (existingPr) {
        await this.deps.host.commentOnPullRequest(target.repo, existingPr.number, body);
      } else {
        const pr = await this.deps.host.createPullRequest(target.repo, {
          title: "docs: project status",
          body: `${body}\n\nForerunner keeps docs/status.md on this branch and adds each session's update to this pull request until it is merged. Opened by Forerunner.`,
          head: branch,
          base: target.base,
        });
        prUrl = pr.htmlUrl;
      }
    }
    await this.backToBase(git, target);
    this.logger.info("status update written", {
      projectId: project.id,
      sessionId: session.id,
      branch,
      prUrl,
      committed: commit.committed,
    });
    return { location: "repo", branch, prUrl, path: STATUS_DOC, created: res.created };
  }

  /**
   * A project's folder (no repository): the status update, then one commit of everything the
   * session left in the folder. The executor commits a baseline before each run ("Workspace
   * before ..."), so the last task's work, and the status file, stayed uncommitted after the
   * project was done (live, 2026-11-01 and all four runs of 2026-11-02). Runs of this session
   * were reviewed before it ends, so the commit changes nothing the critic reads.
   */
  private async statusInFolder(
    project: ProjectRow,
    session: SessionRow,
    update: StatusUpdate,
  ): Promise<SessionStatusOutcome> {
    const dir = this.workspaceDir(project.id);
    mkdirSync(dir, { recursive: true });
    const res = await writeStatusUpdate(dir, update);
    let commit: string | null = null;
    try {
      const git = new GitOps({ cwd: dir, identity: this.deps.identity ?? WORKSPACE_IDENTITY });
      if (!existsSync(join(dir, ".git"))) await git.init("main");
      ensureWorkspaceGitignore(dir);
      const done = update.done.length
        ? `Did ${update.done.map((t) => `"${t}"`).join(", ")}`
        : "Work of the session";
      const made = await git.commitAll(
        `${done.slice(0, 200)}\n\nSession ${session.id}, ${update.endedAt}. Committed by Forerunner at the end of the session.`,
      );
      commit = made.committed ? made.sha : null;
    } catch (e) {
      // The status file is written either way; the history is a convenience.
      this.logger.warn("the session's work was not committed in the folder", {
        projectId: project.id,
        error: errorMessage(e),
      });
    }
    return { location: "data_dir", dir, path: res.path, created: res.created, commit };
  }

  /**
   * The docs waiting in one of Forerunner's docs pull requests (the scaffold, the intake's set,
   * the status), for the Docs tab: "waiting in pull request #1". Reads the host and fetches the
   * docs clone; nothing when the project has no repository or no docs clone yet.
   */
  async docsInPullRequests(project: ProjectRow): Promise<DocInPullRequest[]> {
    const target = await this.deps.repoFor(project);
    if (!target) return [];
    const dir = join(this.deps.worktreeRoot, safeSegment(project.id, "project"));
    if (!existsSync(join(dir, ".git"))) return [];
    const git = new GitOps({
      cwd: dir,
      auth: gitAuthFor(await resolveGitToken(this.deps.token), target.clone),
      identity: this.deps.identity,
    });
    await git.fetch();
    const prs = (await this.deps.host.listPullRequests(target.repo, { state: "open" })).filter(
      (p) => isDocsBranch(p.head.ref),
    );
    const out: DocInPullRequest[] = [];
    for (const pr of prs) {
      if (!(await git.hasRef(`origin/${pr.head.ref}`))) continue;
      for (const path of await git.changedFiles(`origin/${target.base}`, `origin/${pr.head.ref}`))
        if (!out.some((d) => d.path === path))
          out.push({ path, number: pr.number, url: pr.htmlUrl });
    }
    return out;
  }

  /**
   * The project's open work for the top sections of status.md: the latest done tasks, every
   * task in flight or blocked, the ready ones highest priority first.
   */
  private async projectState(projectId: string): Promise<StatusLists> {
    const tasks = await this.deps.store.task.forProject(projectId, {}, { limit: 2000 });
    const titles = (rows: TaskRow[]) => rows.slice(0, STATUS_STATE_LIMIT).map((t) => t.title);
    const byUpdated = (a: TaskRow, b: TaskRow) => b.updated_at.localeCompare(a.updated_at);
    const byPriority = (a: TaskRow, b: TaskRow) =>
      b.priority - a.priority || a.created_at.localeCompare(b.created_at);
    return {
      done: titles(tasks.filter((t) => t.status === "done").sort(byUpdated)),
      inFlight: titles(
        tasks.filter((t) => ["claimed", "in_progress", "in_review"].includes(t.status)),
      ),
      blocked: titles(tasks.filter((t) => t.status === "needs_human" || t.status === "failed")),
      next: titles(
        tasks.filter((t) => t.status === "ready" || t.status === "draft").sort(byPriority),
      ),
    };
  }

  /**
   * The project's docs clone on `branch`: from `origin/<branch>` when the branch exists on
   * the host (an open PR's, an earlier scaffold), else from the default branch; `fresh` starts
   * it from the default branch whatever the host has. An empty repository first gets the doc
   * set as its first commit on the default branch (`first` says what went in, ADR 0106).
   */
  private async checkout(
    project: ProjectRow,
    target: ProjectRepoTarget,
    branch: string,
    opts: { fresh?: (openPr: boolean) => Promise<boolean> } = {},
  ) {
    const dir = join(this.deps.worktreeRoot, safeSegment(project.id, "project"));
    mkdirSync(this.deps.worktreeRoot, { recursive: true });
    // The token goes to the repository's origin only (ADR 0069): never to a remote a git
    // config rewrite or a host answer points elsewhere, and not at all to a non-http remote.
    const auth = gitAuthFor(await resolveGitToken(this.deps.token), target.clone);
    const git = new GitOps({ cwd: dir, auth, identity: this.deps.identity });
    if (existsSync(join(dir, ".git"))) await git.fetch();
    else await git.clone(target.clone);
    let first: { created: string[]; marker: InstallMarkerWrite | null } | null = null;
    await ensureBaseBranch({
      git,
      cloneUrl: target.clone,
      base: target.base,
      repoName: `${target.repo.owner}/${target.repo.name}`,
      scratchDir: join(this.deps.worktreeRoot, "first-commit", safeSegment(project.id, "project")),
      ...(auth ? { auth } : {}),
      ...(this.deps.identity ? { identity: this.deps.identity } : {}),
      first: async (scratch) => {
        const res = await scaffoldDocs(scratch, {
          name: project.name,
          goal: project.goal,
          repos: project.repos,
        });
        const marker = await this.mark(project, scratch);
        first = { created: res.created, marker };
        return `docs: start the repository with the standard doc set\n\nThe repository was empty; Forerunner made this first commit so the project's work has a branch to start from:\n${res.created.map((p) => `- ${p}`).join("\n")}`;
      },
    });
    const existingPr =
      (await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch }))[0] ??
      null;
    const fresh = opts.fresh ? await opts.fresh(!!existingPr) : false;
    if (!fresh && (await git.hasRef(`origin/${branch}`)))
      await git.createBranch(branch, `origin/${branch}`);
    else await git.createBranch(branch, `origin/${target.base}`);
    return {
      git,
      dir,
      existingPr,
      first: first as { created: string[]; marker: InstallMarkerWrite | null } | null,
    };
  }

  /**
   * The docs clone back on the default branch as the host has it, so what reads the clone (the
   * Docs and Files tabs, the chat's docs search) sees what is merged, not the last branch a
   * docs write used (before, the clone stayed on whichever PR branch was written last).
   */
  private async backToBase(git: GitOps, target: ProjectRepoTarget): Promise<void> {
    try {
      await git.createBranch(target.base, `origin/${target.base}`);
    } catch (e) {
      this.logger.warn("docs clone not back on the default branch", { error: errorMessage(e) });
    }
  }

  /**
   * The install marker (`.forerunner/project.json`, spec A.4, ADR 0056) beside the doc set,
   * naming this project, so a source scan by any install tells a managed repository or folder
   * from a fresh one. Another project's marker (a second install on the repository, or a second
   * project of this install on it) is reported on the outcome and never overwritten.
   */
  private async mark(project: ProjectRow, dir: string): Promise<InstallMarkerWrite> {
    const marker = await writeInstallMarker(dir, { project: project.id, name: project.name });
    if (marker.status === "other_project") {
      this.logger.warn("install marker of another project kept", {
        projectId: project.id,
        markedFor: marker.project,
      });
    }
    return marker;
  }

  private async record(project: ProjectRow, docs: Record<string, unknown>): Promise<void> {
    try {
      const current = (await this.deps.store.project.get(project.id)) ?? project;
      await this.deps.store.project.patch(project.id, {
        summary_cache: { ...current.summary_cache, docs } as never,
      });
    } catch (e) {
      this.logger.warn("docs record not written", {
        projectId: project.id,
        error: errorMessage(e),
      });
    }
  }
}

function line(items: string[]): string {
  return items.length ? items.join("; ") : "none";
}
