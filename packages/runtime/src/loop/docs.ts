import { existsSync, mkdirSync } from "node:fs";
import { type GitHost, GitOps, type RepoRef } from "@forerunner/capabilities";
import {
  STATUS_DOC,
  type StatusLists,
  type StatusUpdate,
  scaffoldDocs,
  writeStatusUpdate,
} from "@forerunner/memory";
import { type Clock, errorMessage, isAbsolute, join, log, safeSegment } from "@forerunner/platform";
import type { ProjectRow, SessionRow, StateStore, TaskRow } from "@forerunner/state";
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
 * committed to `docs/status.md` on the session's pull request branch (so that PR carries it)
 * or on a small PR of its own. The default branch is never pushed and an existing file is
 * never overwritten (`scaffoldDocs` skips what is there, drafted intake files included).
 * A project without a repository keeps the set under `<projectsRoot>/<project id>/workspace`.
 * The critic's drift check (`checkDocDrift`) reads the same files.
 */
export const DOCS_SCAFFOLD_BRANCH = "fr/docs-scaffold";

/** Directory under the project's data root holding the doc set of a project without a repo. */
export const WORKSPACE_DIR = "workspace";

/** The branch of a session's own status PR (the whole id: a prefix could collide). */
export function statusBranchFor(sessionId: string): string {
  return `fr/status-${safeSegment(sessionId, "session")}`;
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
  token?: string;
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
        outcome = { location: "data_dir", dir, created: res.created, existing: res.existing };
      } else {
        const branch = DOCS_SCAFFOLD_BRANCH;
        const { git, dir, existingPr } = await this.checkout(project, target, branch);
        const res = await scaffoldDocs(dir, info);
        let prUrl = existingPr?.htmlUrl ?? null;
        if (res.created.length) {
          const list = res.created.map((p) => `- ${p}`).join("\n");
          await git.commitAll(`docs: scaffold the standard doc set\n\n${list}`);
          await git.push(branch, { defaultBranch: target.base });
          if (existingPr) {
            await this.deps.host.commentOnPullRequest(
              target.repo,
              existingPr.number,
              `Added the missing standard docs for project ${project.name}:\n${list}`,
            );
          } else {
            const pr = await this.deps.host.createPullRequest(target.repo, {
              title: "docs: scaffold the standard project doc set",
              body: `Standard project docs for ${project.name} (spec G.5), written from templates for the files the repository lacked:\n${list}\n\nExisting files were left as they are${res.existing.length ? ` (${res.existing.join(", ")})` : ""}. Opened by Forerunner.`,
              head: branch,
              base: target.base,
            });
            prUrl = pr.htmlUrl;
          }
        }
        outcome = { location: "repo", branch, prUrl, created: res.created, existing: res.existing };
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
      scaffolded_at: this.deps.clock.nowIso(),
    });
    this.logger.info("standard docs scaffolded", {
      projectId: project.id,
      location: outcome.location,
      created: outcome.created.length,
      prUrl: outcome.prUrl ?? null,
    });
    return outcome;
  }

  async writeSessionStatus(input: {
    project: ProjectRow;
    session: SessionRow;
    update: SessionStatusUpdate;
    prBranch?: string | null;
  }): Promise<SessionStatusOutcome> {
    const { project, session } = input;
    const update: StatusUpdate = { ...input.update, state: await this.projectState(project.id) };
    const target = await this.deps.repoFor(project);
    if (!target) {
      const dir = this.workspaceDir(project.id);
      mkdirSync(dir, { recursive: true });
      const res = await writeStatusUpdate(dir, update);
      return { location: "data_dir", dir, path: res.path, created: res.created };
    }
    const branch = input.prBranch || statusBranchFor(session.id);
    const { git, dir, existingPr } = await this.checkout(project, target, branch);
    const res = await writeStatusUpdate(dir, update);
    const commit = await git.commitAll(`docs: status after session ${session.id}`);
    let prUrl = existingPr?.htmlUrl ?? null;
    if (commit.committed) {
      await git.push(branch, { defaultBranch: target.base });
      if (!existingPr) {
        const pr = await this.deps.host.createPullRequest(target.repo, {
          title: `docs: status after session ${session.id.slice(0, 8)}`,
          body: `Status update of session ${session.id} (${update.endedAt}):\n\n- Done: ${line(update.done)}\n- In flight: ${line(update.inFlight)}\n- Blocked: ${line(update.blocked)}\n- Next: ${line(update.next)}\n\nOpened by Forerunner; the session opened no other pull request.`,
          head: branch,
          base: target.base,
        });
        prUrl = pr.htmlUrl;
      }
    }
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
   * the host (the session's PR branch, an earlier scaffold), else from the default branch.
   */
  private async checkout(project: ProjectRow, target: ProjectRepoTarget, branch: string) {
    const dir = join(this.deps.worktreeRoot, safeSegment(project.id, "project"));
    mkdirSync(this.deps.worktreeRoot, { recursive: true });
    const git = new GitOps({
      cwd: dir,
      auth: this.deps.token ? { token: this.deps.token } : undefined,
      identity: this.deps.identity,
    });
    if (existsSync(join(dir, ".git"))) await git.fetch();
    else await git.clone(target.clone);
    const existingPr =
      (await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch }))[0] ??
      null;
    try {
      await git.createBranch(branch, `origin/${branch}`);
    } catch {
      await git.createBranch(branch, `origin/${target.base}`);
    }
    return { git, dir, existingPr };
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
