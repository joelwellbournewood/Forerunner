import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  ensureBaseBranch,
  ensureWorkspaceGitignore,
  excludeNeverPushed,
  type GitAuth,
  type GitHost,
  GitOps,
  type GitTokenSource,
  gitAuthFor,
  LOCAL_ONLY_DIR,
  LOCAL_ONLY_LINE,
  LOCAL_ONLY_TRACKED_LINE,
  NEVER_PUSHED,
  type RepoRef,
  resolveGitToken,
  TRY_DIR,
  WORKSPACE_IDENTITY,
} from "@forerunner/capabilities";
import {
  STATUS_DOC,
  type StatusLists,
  type StatusUpdate,
  scaffoldDocs,
  writeStatusUpdate,
} from "@forerunner/memory";
import {
  type Clock,
  errorMessage,
  fromPosix,
  isAbsolute,
  join,
  log,
  safeSegment,
} from "@forerunner/platform";
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
 * docs still waiting in a pull request; with the status pull request off (C-57) the session's
 * end still clones or fetches that copy and puts it on the default branch (`refreshCopy`),
 * pushing nothing. A project without a repository keeps the set under
 * `<projectsRoot>/<project id>/workspace`, where the session's work is committed with the
 * status update at session end. The critic's drift check (`checkDocDrift`) reads the same files.
 *
 * This computer's copy (merged-copy, ADR 0113, the owner's decision of 2026-11-02): the docs
 * clone is also what the Files tab, Open folder and the chat's docs search read, so it follows
 * every merge, not only a session's end: `refreshCopy` runs on every merge the app makes
 * (`ReviewedPrMerge.onMerged`), on the git host watcher's read of the default branch's head (a
 * merge by anyone, on GitHub's website too), when a repository is linked and after the intake
 * wrote its docs. One lock per copy (`withCopy`): the refresh, every docs write and the preview
 * of a pull request take it, so git never runs twice at once in the clone and a refresh waits
 * for a docs write that has the clone on another branch. The copy keeps a `Local only` folder
 * that git never sees (`.git/info/exclude`) and Forerunner never uploads (`local-only.ts`).
 */
export const DOCS_SCAFFOLD_BRANCH = "fr/docs-scaffold";

/** Forerunner's branch for `docs/status.md` in a repository: one pull request at a time. */
export const STATUS_BRANCH = "fr/status";

/**
 * The project setting that sends each session's status update to the repository as a pull
 * request (C-57, ADR 0106 point 3, the session lead's default): off unless the person turns it
 * on (`settings.set status_pull_request`); off, a repository project's `docs/status.md` stays in
 * the app (`STATUS_IN_APP_DIR`), read by the Docs tab, and no status pull request is opened.
 */
export const STATUS_PR_SETTING = "status_pull_request";

/** Whether the project sends its status update to its repository as a pull request (C-57). */
export function statusPullRequestOn(project: Pick<ProjectRow, "settings">): boolean {
  return project.settings?.[STATUS_PR_SETTING] === true;
}

/** `<projectsRoot>/<project id>/app-status`: where a repository project's status stays (C-57). */
export const STATUS_IN_APP_DIR = "app-status";

/** The branches Forerunner keeps the project's docs on (scaffold, the intake's set, status). */
export function isDocsBranch(branch: string): boolean {
  return (
    branch === DOCS_SCAFFOLD_BRANCH ||
    branch === STATUS_BRANCH ||
    /^fr\/intake-[^/]+-docs$/.test(branch)
  );
}

/** The line a scaffold pull request's body ends with, naming the project it is for (L-16). */
export function scaffoldProjectLine(project: Pick<ProjectRow, "id">): string {
  return `Forerunner project ${project.id}.`;
}

/**
 * Whether one of Forerunner's docs pull requests on the repository is this project's (L-16):
 * live, the Overview listed another project's stale scaffold PR ("The project's standard docs ·
 * pull request #1", from an earlier project on the same repository) as this one's. The intake's
 * set is on a branch named for the project; the status PR is this project's only while its
 * status pull request is on (C-57); a scaffold PR names its project in its body (since L-16;
 * before, by name in its first line).
 */
export function isProjectDocsPr(
  project: Pick<ProjectRow, "id" | "name" | "settings"> &
    Partial<Pick<ProjectRow, "summary_cache">>,
  pr: { head: { ref: string }; body: string; htmlUrl?: string },
): boolean {
  const ref = pr.head.ref;
  if (ref === STATUS_BRANCH) return statusPullRequestOn(project);
  const intake = /^fr\/intake-(.+)-docs$/.exec(ref);
  if (intake) return intake[1] === safeSegment(project.id, "project");
  if (ref === DOCS_SCAFFOLD_BRANCH) {
    // The PR the project's scaffold wrote its docs onto (recorded at creation) is its own.
    const recorded = (project.summary_cache?.docs as { pr_url?: unknown } | undefined)?.pr_url;
    if (pr.htmlUrl && recorded === pr.htmlUrl) return true;
    const body = pr.body ?? "";
    if (body.includes(scaffoldProjectLine(project))) return true;
    if (/Forerunner project \S+\./.test(body)) return false;
    return body.startsWith(`Standard project docs for ${project.name} (spec G.5)`);
  }
  return false;
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

/**
 * What this computer's copy holds, kept in the clone's `.git` (never in the work): when it was
 * last brought to the default branch as the host has it, at which commit, and whether it has
 * its Local only folder (`tracked`: the repository already has files under `Local only/`).
 */
export const COPY_RECORD = "forerunner-copy.json";

export interface CopyRecord {
  updatedAt: string;
  head: string | null;
  localOnly: "folder" | "tracked" | "none";
}

/** What the Files tab says about a repository project's copy (`GET /projects/:id/files`). */
export interface CopyView {
  /** When the copy was last brought to what is merged on the host; null before the first time. */
  updatedAt: string | null;
  /** The Local only folder and its line; `folder` null with the sentence when there is none. */
  localOnly: { folder: string | null; line: string } | null;
}

/** The copy's record, or null before the first refresh (or when it cannot be read). */
export function readCopyRecord(dir: string): CopyRecord | null {
  try {
    const r = JSON.parse(readFileSync(join(dir, ".git", COPY_RECORD), "utf8")) as CopyRecord;
    return typeof r.updatedAt === "string" ? r : null;
  } catch {
    return null;
  }
}

/** A project's repository as `owner/name` from its first entry; null for a folder or none. */
function repositoryOf(project: Pick<ProjectRow, "repos">): RepoRef | null {
  const first = project.repos[0]?.trim() ?? "";
  if (!first || isAbsolute(first)) return null;
  return parseRepoRef(first);
}

/**
 * The copies a step works in now, in this process: one at a time per clone (`withCopy`). A
 * chain of promises per folder, so every caller runs in the order it asked.
 */
const copiesInUse = new Map<string, Promise<void>>();

async function inCopy<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = copiesInUse.get(dir) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const tail = before.then(() => mine);
  copiesInUse.set(dir, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (copiesInUse.get(dir) === tail) copiesInUse.delete(dir);
  }
}

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

  /** `<projectsRoot>/<project id>/app-status`: a repository project's status in the app (C-57). */
  statusInAppDir(projectId: string): string {
    return join(this.deps.projectsRoot, safeSegment(projectId, "project"), STATUS_IN_APP_DIR);
  }

  /**
   * Where the Docs tab reads `docs/status.md` first (C-57): the app's copy of a repository
   * project whose status pull request is off, once a session wrote it; null otherwise (the
   * repository's, as merged, or the project's folder).
   */
  statusDocRoot(project: ProjectRow): string | null {
    if (!parseRepoRef(project.repos[0] ?? "") || isAbsolute(project.repos[0] ?? "")) return null;
    if (statusPullRequestOn(project)) return null;
    const dir = this.statusInAppDir(project.id);
    return existsSync(join(dir, fromPosix(STATUS_DOC))) ? dir : null;
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

  /** `<worktreeRoot>/<project id>`: this computer's copy of a repository project. */
  copyDir(projectId: string): string {
    return join(this.deps.worktreeRoot, safeSegment(projectId, "project"));
  }

  /**
   * Run `fn` with the project's copy to itself (one lock per copy): the refresh, every docs
   * write and 'merged-actions''s preview of a pull request go through it, so git never runs
   * twice at once in the clone. Waits for the step before it; a failing step frees it too.
   */
  withCopy<T>(projectId: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = this.copyDir(projectId);
    return inCopy(dir, () => fn(dir));
  }

  /**
   * What the Files tab says about a repository project's copy: when it was last brought to what
   * is merged, and its Local only folder. Null for a project without a repository. Reads only
   * the clone's record and folders (no git, no network).
   */
  copyView(project: ProjectRow): CopyView | null {
    if (!repositoryOf(project)) return null;
    const record = readCopyRecord(this.copyDir(project.id));
    const folder = this.localOnlyFolder(project);
    return {
      updatedAt: record?.updatedAt ?? null,
      localOnly: folder
        ? { folder, line: LOCAL_ONLY_LINE }
        : record?.localOnly === "tracked"
          ? { folder: null, line: LOCAL_ONLY_TRACKED_LINE }
          : null,
    };
  }

  /**
   * The project's Local only folder in its copy (`<copy>/Local only`), which each task's run
   * gets in its worktree; null for a project without a repository, before the copy exists, and
   * for a repository that already tracks a folder of that name.
   */
  localOnlyFolder(project: Pick<ProjectRow, "id" | "repos">): string | null {
    if (!repositoryOf(project)) return null;
    const dir = this.copyDir(project.id);
    if (readCopyRecord(dir)?.localOnly !== "folder") return null;
    const folder = join(dir, LOCAL_ONLY_DIR);
    try {
      return statSync(folder).isDirectory() ? folder : null;
    } catch {
      return null;
    }
  }

  /**
   * This computer's copy of the repository brought to what is merged (`<worktreeRoot>/<project
   * id>`, the docs clone that `docsDirsFor` reads for the Docs and Files tabs and the chat's docs
   * search): cloned when it is missing, fetched, and put on the default branch as the host has
   * it, with its Local only folder. Called after every merge (the app's, or one the watcher saw
   * as the default branch's new head: `head`), at the end of a session, when a repository is
   * linked and after the intake wrote its docs. Under the copy's lock, so it waits for a docs
   * write. With `head`, a copy already at that commit and on the default branch is not fetched
   * again (the watcher reads the head every poll); it is recorded as checked. Nothing is pushed;
   * an empty repository is left as cloned, with no default branch to read yet.
   */
  async refreshCopy(
    project: ProjectRow,
    opts: { head?: string } = {},
  ): Promise<{ refreshed: boolean }> {
    const target = await this.deps.repoFor(project);
    if (!target) return { refreshed: false };
    return this.withCopy(project.id, async (dir) => {
      const auth = gitAuthFor(await resolveGitToken(this.deps.token), target.clone);
      const git = this.gitOf(dir, auth);
      if (opts.head && existsSync(join(dir, ".git"))) {
        const at = await git.resolveRef("HEAD").catch(() => null);
        const on = await git.currentBranch().catch(() => "");
        if (at === opts.head && on === target.base) {
          await this.settle(git, dir, target, { checkout: false });
          return { refreshed: false };
        }
      }
      mkdirSync(this.deps.worktreeRoot, { recursive: true });
      if (existsSync(join(dir, ".git"))) await git.fetch();
      else await git.clone(target.clone);
      await this.settle(git, dir, target, { checkout: true });
      return { refreshed: true };
    });
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
        // The copy to itself (merged-copy): a refresh or another docs write waits.
        outcome = await this.withCopy(project.id, () => this.scaffoldInCopy(project, target));
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

  /** The scaffold of a repository project, in its copy (under the copy's lock). */
  private async scaffoldInCopy(
    project: ProjectRow,
    target: ProjectRepoTarget,
  ): Promise<DocsScaffoldOutcome> {
    const info = { name: project.name, goal: project.goal, repos: project.repos };
    const branch = DOCS_SCAFFOLD_BRANCH;
    const { git, dir, existingPr, first } = await this.checkout(project, target, branch);
    if (first) {
      // An empty repository: the set went in as its first commit on the default branch.
      await this.settle(git, dir, target);
      return {
        location: "repo",
        branch: target.base,
        prUrl: null,
        created: first.created,
        existing: [],
        ...(first.marker ? { marker: first.marker } : {}),
        firstCommit: true,
      };
    }
    const res = await scaffoldDocs(dir, info);
    const marker = await this.mark(project, dir);
    const written = [...res.created, ...(marker.status === "created" ? [marker.path] : [])];
    // An open scaffold PR this project adds nothing to and that is not its own (another
    // project's on the same repository) is never recorded as its docs PR (L-16): the
    // Overview listed one as "The project's standard docs".
    let prUrl =
      existingPr && (written.length > 0 || isProjectDocsPr(project, existingPr))
        ? existingPr.htmlUrl
        : null;
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
          body: `Standard project docs for ${project.name} (spec G.5), written from templates for the files the repository lacked:\n${list}${markerNote}\n\nExisting files were left as they are${res.existing.length ? ` (${res.existing.join(", ")})` : ""}. Opened by Forerunner. ${scaffoldProjectLine(project)}`,
          head: branch,
          base: target.base,
        });
        prUrl = pr.htmlUrl;
      }
    }
    await this.settle(git, dir, target);
    return {
      location: "repo",
      branch,
      prUrl,
      created: res.created,
      existing: res.existing,
      marker,
    };
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
    // C-57: unless the person turned the status pull request on, a repository project's status
    // stays in the app: one PR to merge after every session was noise, even for one task.
    if (!statusPullRequestOn(project)) {
      const dir = this.statusInAppDir(project.id);
      mkdirSync(dir, { recursive: true });
      const res = await writeStatusUpdate(dir, update);
      // The status write was also what kept this computer's copy of the repository current;
      // without it a project made from a brief had no copy at all (its Docs tab said README.md
      // was missing, its Files tab "Nothing written yet") and a merge never showed (review of
      // fix/decisions, 2026-11-02). The copy is refreshed here, with nothing pushed.
      try {
        await this.refreshCopy(project);
      } catch (e) {
        // The status is in the app either way; the copy is read as it was.
        this.logger.warn("this computer's copy of the repository not refreshed", {
          projectId: project.id,
          error: errorMessage(e),
        });
      }
      return { location: "app", dir, path: res.path, created: res.created };
    }
    // Forerunner's own status branch, never a task's: the critic accepted the task's branch,
    // and a commit after the review would put a file it never saw into the reviewed PR. Under
    // the copy's lock (merged-copy): a refresh never moves the clone off the branch mid-write.
    const branch = STATUS_BRANCH;
    const { commit, prUrl, res } = await this.withCopy(project.id, async () => {
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
      await this.settle(git, dir, target);
      return { commit, prUrl, res };
    });
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
      // W6-26: a review's try folder a dead daemon left is never committed with the session.
      excludeNeverPushed(dir, [TRY_DIR]);
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
    if (!existsSync(join(this.copyDir(project.id), ".git"))) return [];
    // Only this project's docs PRs (L-16): another project's on the same repository is not
    // where this project's docs wait.
    const prs = (await this.deps.host.listPullRequests(target.repo, { state: "open" })).filter(
      (p) => isDocsBranch(p.head.ref) && isProjectDocsPr(project, p),
    );
    // The fetch under the copy's lock (merged-copy): never beside a refresh or a docs write.
    return this.withCopy(project.id, async (dir) => {
      const git = this.gitOf(dir, gitAuthFor(await resolveGitToken(this.deps.token), target.clone));
      await git.fetch();
      const out: DocInPullRequest[] = [];
      for (const pr of prs) {
        if (!(await git.hasRef(`origin/${pr.head.ref}`))) continue;
        for (const path of await git.changedFiles(`origin/${target.base}`, `origin/${pr.head.ref}`))
          if (!out.some((d) => d.path === path))
            out.push({ path, number: pr.number, url: pr.htmlUrl });
      }
      return out;
    });
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
    const git = this.gitOf(dir, auth);
    if (existsSync(join(dir, ".git"))) await git.fetch();
    else await git.clone(target.clone);
    // Local only and a try folder are never staged by a docs commit (merged-copy).
    excludeNeverPushed(dir);
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
   * The git of the copy, with the token scoped to the repository's origin (ADR 0069) and the
   * push guard on (merged-copy): no docs write ever uploads Local only or a try folder.
   */
  private gitOf(dir: string, auth: GitAuth | undefined): GitOps {
    return new GitOps({
      cwd: dir,
      ...(auth ? { auth } : {}),
      ...(this.deps.identity ? { identity: this.deps.identity } : {}),
      neverPush: NEVER_PUSHED,
    });
  }

  /**
   * The copy as the Files tab reads it, after a refresh or a docs write (under the copy's
   * lock): on the default branch as the host has it (`checkout`, when it has one), Local only
   * and a try folder kept out of git, the Local only folder made unless the default branch
   * already tracks a folder of that name, and the record of when this was.
   */
  private async settle(
    git: GitOps,
    dir: string,
    target: ProjectRepoTarget,
    opts: { checkout?: boolean } = {},
  ): Promise<void> {
    const base = `origin/${target.base}`;
    const hasBase = await git.hasRef(base);
    // A copy that could not be put on the default branch (a file the person changed in it that
    // the merge also changed) keeps the time of its last real update.
    const moved = hasBase && opts.checkout !== false ? await this.backToBase(git, target) : true;
    const before = readCopyRecord(dir);
    excludeNeverPushed(dir);
    const tracked = hasBase ? ((await git.trackedUnder(base, [LOCAL_ONLY_DIR])) ?? []) : [];
    let localOnly: CopyRecord["localOnly"] = "none";
    if (tracked.length) localOnly = "tracked";
    else {
      try {
        mkdirSync(join(dir, LOCAL_ONLY_DIR), { recursive: true });
        localOnly = "folder";
      } catch (e) {
        this.logger.warn("the Local only folder was not made", { error: errorMessage(e) });
      }
    }
    const record: CopyRecord =
      moved || !before
        ? {
            updatedAt: this.deps.clock.nowIso(),
            head: hasBase ? await git.resolveRef(base) : null,
            localOnly,
          }
        : { ...before, localOnly };
    try {
      writeFileSync(join(dir, ".git", COPY_RECORD), JSON.stringify(record), "utf8");
    } catch (e) {
      this.logger.warn("the copy's record was not written", { error: errorMessage(e) });
    }
  }

  /**
   * The docs clone back on the default branch as the host has it, so what reads the clone (the
   * Docs and Files tabs, the chat's docs search) sees what is merged, not the last branch a
   * docs write used (before, the clone stayed on whichever PR branch was written last).
   */
  private async backToBase(git: GitOps, target: ProjectRepoTarget): Promise<boolean> {
    try {
      await git.createBranch(target.base, `origin/${target.base}`);
      return true;
    } catch (e) {
      this.logger.warn("docs clone not back on the default branch", { error: errorMessage(e) });
      return false;
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
