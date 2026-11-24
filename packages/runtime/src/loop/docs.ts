import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  branchSegment,
  dropKeptSame,
  ensureBaseBranch,
  ensureWorkspaceGitignore,
  excludeNeverPushed,
  forerunnerMarker,
  type GitAuth,
  type GitHost,
  GitOps,
  type GitTokenSource,
  gitAuthFor,
  keepLocalOnlyFromCheckout,
  LOCAL_ONLY_DIR,
  LOCAL_ONLY_LINE,
  LOCAL_ONLY_TRACKED_LINE,
  localOnlyTakenLine,
  NEVER_PUSHED,
  type PullRequestInfo,
  type RepoRef,
  readForerunnerMarker,
  regularFilesUnder,
  resolveGitToken,
  sessionWords,
  TRY_DIR,
  WORKSPACE_IDENTITY,
} from "@forerunner/capabilities";
import {
  GUIDE_FILE,
  GUIDE_IMPORT_FILE,
  GUIDE_IMPORT_LINE,
  type GuideFacts,
  guidePartOf,
  renderGuidePart,
  type ScaffoldResult,
  STATUS_DOC,
  type StatusIssueState,
  type StatusLists,
  type StatusUpdate,
  scaffoldDocs,
  writeStatusUpdate,
} from "@forerunner/memory";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  fromPosix,
  isAbsolute,
  join,
  log,
  safeSegment,
} from "@forerunner/platform";
import type { ProjectRow, SessionRow, StateStore, TaskRow } from "@forerunner/state";
import {
  INSTALL_MARKER_FILE,
  type InstallMarkerWrite,
  parseInstallMarker,
  writeInstallMarker,
} from "../sources/marker.ts";
import { RepositoryIndex, tookOverLine } from "../sources/repository-use.ts";
import { isTogether, projectIdsOf, tookOverOf } from "../sources/repository-words.ts";
import { guideFactsOf, guideKeyOf } from "./guide.ts";
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

/**
 * The folder under the docs clones' root that holds each project's pull request preview
 * ('merged-actions': `<worktreeRoot>/previews/<project id>/pr-<n>`), beside the copies.
 */
export const PREVIEWS_DIR = "previews";

/** The preview's record beside its folder: which pull request, and whether it merged cleanly. */
const PREVIEW_RECORD = "preview.json";

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

/**
 * W15-01 fix-up: a file in `STATUS_IN_APP_DIR` that says the project's last status stayed in
 * the app because another project's status pull request was open on `fr/status`, although its
 * own status pull request is on. While it is there, the Docs tab reads `docs/status.md` from
 * the app (`statusDocRoot`), as with the setting off; the project's next status written to its
 * own pull request (or kept in the app with the setting off) removes it. A file, so a restart
 * reads it the same way.
 */
export const STATUS_HELD_MARK = ".held-by-another-status-pr";

/**
 * Whether `branch` is one of the scaffold's branches: `fr/docs-scaffold`, or the project's own
 * `fr/docs-scaffold-<project name>` when that one is not the project's (D-L4-24).
 */
export function isScaffoldBranch(branch: string): boolean {
  return branch === DOCS_SCAFFOLD_BRANCH || /^fr\/docs-scaffold-[\w-]+$/.test(branch);
}

/**
 * The branches the scaffold may write on, in order (L4-github-102, D-L4-24): `fr/docs-scaffold`,
 * then `fr/docs-scaffold-<project name>`, then that with 8 characters of the project's id. A
 * branch is taken when it is free on GitHub, holds this project's open scaffold pull request, or
 * is this project's own (its marker names the project); Forerunner never writes over a branch it
 * did not write for this project (a closed pull request's branch is kept by GitHub, and it can
 * be another project's or another person's).
 */
export function scaffoldBranchesOf(project: Pick<ProjectRow, "id" | "name">): string[] {
  // One rule with the plan's docs branch and a task's (`branchSegment`, L4e-left-2).
  const slug = branchSegment(project.name, "project");
  const hex = project.id.toLowerCase().replace(/[^0-9a-f]/g, "");
  const own = hex.length >= 8 ? hex.slice(-8) : safeSegment(project.id, "project").slice(0, 8);
  return [
    DOCS_SCAFFOLD_BRANCH,
    `${DOCS_SCAFFOLD_BRANCH}-${slug}`,
    `${DOCS_SCAFFOLD_BRANCH}-${slug}-${own}`,
  ];
}

/**
 * Whether a scaffold run left a docs pull request that names the project (L4-github-102): one
 * is open (or was commented on) and the marker on it is not another project's. A take-over is
 * said as landed only then (`repo.take_over`'s sentence, the Overview's line).
 */
export function docsPullRequestNamesProject(
  out: Pick<DocsScaffoldOutcome, "prUrl" | "marker">,
): boolean {
  return !!out.prUrl && out.marker?.status !== "other_project";
}

/** The branches Forerunner keeps the project's docs on (scaffold, the intake's set, status). */
export function isDocsBranch(branch: string): boolean {
  return (
    isScaffoldBranch(branch) || branch === STATUS_BRANCH || /^fr\/intake-[^/]+-docs$/.test(branch)
  );
}

/**
 * The visible line a scaffold pull request's body ended with before wave 15, naming the project
 * it is for (L-16). Still read, so a scaffold pull request an earlier version opened stays its
 * project's; new pull requests carry the hidden mark instead (`docsPrMarker`, W15-08: no id in
 * what a person reads).
 */
export function scaffoldProjectLine(project: Pick<ProjectRow, "id">): string {
  return `Forerunner project ${project.id}.`;
}

/** The hidden mark of a project's docs pull request (status, scaffold): the project's id. */
export function docsPrMarker(project: Pick<ProjectRow, "id">): string {
  return forerunnerMarker({ project: project.id });
}

/**
 * Whether one of Forerunner's docs pull requests on the repository is this project's, so that a
 * write may go onto it (L-16, W15-01, L4i-left-2). Live, the Overview listed another project's
 * stale scaffold PR ("The project's standard docs · pull request #1"); and a second project with
 * its status pull request on wrote its status into the first project's open status PR on the
 * shared `fr/status` branch and listed it with Merge (live check 2). The intake's set is on a
 * branch named for the project; a status or scaffold PR names its project in its hidden mark
 * (`docsPrMarker`, wave 15); a scaffold PR an earlier version opened names it in a visible line
 * (`scaffoldProjectLine`, L-16) or was recorded at creation (its address in the project's
 * record: this install opened it).
 *
 * L4i-left-2 (wave 8, the brief's "Never" rule: never write to another Forerunner's pull
 * request): a scaffold PR that names no project is this project's only when its branch's own
 * `.forerunner/project.json` names this project itself (`branchMarker`, read from GitHub's copy
 * of the branch; a project it took over does not count: the take-over writes only its own
 * branch). Otherwise it is nobody's: nothing is pushed to it or commented on it (fails closed).
 * Before, "this project is the only one on this install linked to the repository" made it this
 * project's, and another Forerunner's project is never on this install, so any unmarked scaffold
 * pull request (another Forerunner's, a person's, an older version's) was written onto. That
 * fallback now only lists such a pull request, without Merge (`docsPrListing`). A status PR is
 * this project's only by its mark here (the status writer keeps its own rule until wave 8's
 * status issue replaces it). The status PR counts only while the project's status pull request
 * is on (C-57).
 */
export function isProjectDocsPr(
  project: Pick<ProjectRow, "id" | "name" | "settings"> &
    Partial<Pick<ProjectRow, "summary_cache">>,
  pr: { head: { ref: string }; body: string; htmlUrl?: string },
  opts: { branchMarker?: string | null } = {},
): boolean {
  // D9 (d1109-onerepo-link): a project worked on together with another Forerunner shares the
  // other's project id; every docs pull request that names it is the other Forerunner's.
  if (isTogether(project)) return false;
  // A project joined into this one (d1109-onerepo-join) counts as this one.
  const ids = projectIdsOf(project);
  const ref = pr.head.ref;
  if (ref === STATUS_BRANCH) return statusPullRequestOn(project) && isProjectStatusPr(project, pr);
  const intake = /^fr\/intake-(.+)-docs$/.exec(ref);
  if (intake) {
    // L4-github-111: the intake's pull request names its project in its hidden mark (its branch
    // is `fr/intake-<8 characters>-<name>-docs`); one an earlier version opened is on a branch
    // named by the whole id. A short branch without the mark is nobody's (fails closed).
    const marked = readForerunnerMarker(pr.body)?.project?.toLowerCase();
    if (marked) return ids.some((id) => id.toLowerCase() === marked);
    return ids.some((id) => intake[1] === safeSegment(id, "project"));
  }
  if (isScaffoldBranch(ref)) {
    // The PR the project's scaffold wrote its docs onto (recorded at creation) is its own.
    const recorded = (project.summary_cache?.docs as { pr_url?: unknown } | undefined)?.pr_url;
    if (pr.htmlUrl && recorded === pr.htmlUrl) return true;
    const body = pr.body ?? "";
    const marked = readForerunnerMarker(body)?.project;
    if (marked) return ids.includes(marked);
    if (ids.some((id) => body.includes(scaffoldProjectLine({ id })))) return true;
    if (/Forerunner project \S+\./.test(body)) return false;
    const named = opts.branchMarker?.toLowerCase();
    return !!named && ids.some((id) => id.toLowerCase() === named);
  }
  return false;
}

/**
 * Whether a docs pull request names a project at all: its hidden mark, or the visible line an
 * earlier version wrote (L-16). One that names none is a person's, an older version's or
 * another Forerunner's whose body was edited: nobody's for a write (`isProjectDocsPr`).
 */
function namesAProject(pr: { body: string }): boolean {
  return !!readForerunnerMarker(pr.body ?? "")?.project || /Forerunner project \S+\./.test(pr.body);
}

/**
 * L4i-left-2: how the project's Pull requests list shows one of the repository's docs pull
 * requests: `own` with Merge (`isProjectDocsPr`, or a status PR of a project joined into this
 * one is decided by the caller), `listed` as information only, without Merge (a scaffold or
 * status pull request that names no project while this project is the one on this install
 * linked to the repository, `soleLinked`: before, the list offered Merge on it), or null (not
 * listed: another project's, or with two projects linked here neither's).
 */
export function docsPrListing(
  project: Pick<ProjectRow, "id" | "name" | "settings"> &
    Partial<Pick<ProjectRow, "summary_cache">>,
  pr: { head: { ref: string }; body: string; htmlUrl?: string },
  opts: { soleLinked?: boolean } = {},
): "own" | "listed" | null {
  if (isProjectDocsPr(project, pr)) return "own";
  if (isTogether(project) || !opts.soleLinked || namesAProject(pr)) return null;
  const ref = pr.head.ref;
  if (ref === STATUS_BRANCH) return statusPullRequestOn(project) ? "listed" : null;
  return isScaffoldBranch(ref) ? "listed" : null;
}

/**
 * Whether the open status pull request on `fr/status` is this project's (W15-01), whatever its
 * setting: its hidden mark names it (or a project joined into it), or it names no project and
 * this project owns the repository's unmarked docs pull requests (`ownsUnmarkedDocs`: an earlier
 * version's PR). One with another project's mark, or an unmarked one while it is not the one
 * owner, is never written to, commented on or listed. A together project owns none (D9).
 */
export function isProjectStatusPr(
  project: Pick<ProjectRow, "id" | "settings">,
  pr: { body: string },
  opts: { soleLinked?: boolean } = {},
): boolean {
  if (isTogether(project)) return false;
  const marked = readForerunnerMarker(pr.body)?.project;
  if (marked) return projectIdsOf(project).includes(marked);
  return opts.soleLinked === true;
}

/**
 * Whether an unmarked docs pull request (status, scaffold: an earlier version's) on `repo` is
 * `project`'s (W15-01, through the one index of d1109-onerepo-link, ADR 0106 amended): it is
 * the one project on this install using the repository, by the index's identity of a link
 * (every row counts, archived ones too: an unmarked pull request a removed project opened is not
 * another's to take; a project joined into it counts as it; one it took the repository over
 * from does not count), it is no together project (D9: the repository is the other Forerunner's
 * project too), and this computer's copy's marker (`copyMarker`, read as a file) names no other
 * project. Fails closed: an index that cannot be read owns nothing.
 *
 * L4i-left-2 (wave 8): read only to list such a pull request as information (`docsPrListing`)
 * and by the status writer until the status issue replaces it (w8-status-write); the scaffold,
 * Try again, the take-over's rebuild and the Docs tab never take an unmarked pull request as
 * this project's by it (another Forerunner's project is never on this install, so every project
 * here was "the only one").
 */
export async function ownsUnmarkedDocs(
  store: Pick<StateStore, "project">,
  project: Pick<ProjectRow, "id" | "settings">,
  repo: RepoRef,
  copyMarker: string | null = null,
): Promise<boolean> {
  if (isTogether(project)) return false;
  const own = new Set([...projectIdsOf(project), ...(tookOverOf(project)?.projects ?? [])]);
  if (copyMarker) {
    const named = parseInstallMarker(copyMarker)?.project;
    if (named && !own.has(named.toLowerCase()) && !own.has(named)) return false;
  }
  let index: RepositoryIndex;
  try {
    index = await RepositoryIndex.read(store, { hosts: "any" });
  } catch {
    return false;
  }
  const users = index.usersOf(repo).filter((id) => !own.has(id) || id === project.id);
  return users.length === 1 && users[0] === project.id;
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
 * its Local only folder (`tracked`: the repository already has files under `Local only/`;
 * `taken`: it started tracking some after the copy made the folder while the person's own files
 * are still in it, with `kept` naming those moved out of the repository's way).
 */
export const COPY_RECORD = "forerunner-copy.json";

export interface CopyRecord {
  updatedAt: string;
  head: string | null;
  localOnly: "folder" | "tracked" | "taken" | "none";
  /** The person's files renamed "(yours)" for the repository's, relative to the copy. */
  kept?: string[];
  /**
   * R-copystuck (leftovers7-merge2): the last refresh could not bring the copy to what is merged,
   * and why; absent once one did. `updatedAt` keeps the time of the last real update.
   */
  stopped?: CopyStopped;
}

/**
 * Why this computer's copy stopped following what is merged (R-copystuck): `changed`, a file the
 * person changed in the copy that a merge changes too; `in_the_way`, a file of theirs (untracked
 * or ignored) where a merge brings one; `other`, git refused for another reason (on Windows, a
 * path in another letter case). `files` are relative to the copy, with forward slashes.
 */
export interface CopyStopped {
  reason: "changed" | "in_the_way" | "other";
  files: string[];
}

/** What the Files tab says about a repository project's copy (`GET /projects/:id/files`). */
export interface CopyView {
  /** When the copy was last brought to what is merged on the host; null before the first time. */
  updatedAt: string | null;
  /** The Local only folder and its line; `folder` null with the sentence when there is none. */
  localOnly: { folder: string | null; line: string } | null;
  /**
   * R-copystuck: present while the copy cannot follow what is merged, with why and one line
   * for the person (`copyStoppedLine`); `updatedAt` is then the time of its last real update.
   */
  stopped?: CopyStopped & { line: string };
}

/** "a.md, b.md and 2 more" for the files of a line. */
function fileList(files: readonly string[]): string {
  const shown = files.slice(0, 3);
  const more = files.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length <= 1
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/**
 * R-copystuck: the Files tab's line for a copy that stopped following what is merged: what is
 * in the way and what to do (design §5: one sentence, the files by name). Polish owns the words.
 */
export function copyStoppedLine(s: CopyStopped): string {
  const one = s.files.length === 1;
  const list = fileList(s.files);
  if (s.reason === "changed" && s.files.length)
    return `You changed ${list} in this copy, and a merge changed ${one ? "it" : "them"} too: move your change out of the way and the copy follows again.`;
  if (s.reason === "in_the_way" && s.files.length)
    return `${list} in this copy ${one ? "is" : "are"} in the way of ${one ? "a merged file" : "merged files"}: move ${one ? "it" : "them"} and the copy follows again.`;
  return "Git could not bring it to what is merged; it tries again at the next merge.";
}

/** Why git refused to put the copy on the default branch, from its words (R-copystuck). */
export function copyStoppedOf(error: unknown): CopyStopped {
  const text = errorMessage(error);
  const files = [
    ...new Set(
      text
        .split(/\r?\n/)
        .filter((l) => /^\t/.test(l))
        .map((l) => l.trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ),
  ];
  if (/local changes to the following files would be overwritten/i.test(text))
    return { reason: "changed", files };
  if (/(untracked|ignored) working tree files would be (overwritten|removed)/i.test(text))
    return { reason: "in_the_way", files };
  return { reason: "other", files: [] };
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

/** The kept paths (relative to the copy) that are still there. */
function stillThere(dir: string, kept: readonly string[] | undefined): string[] {
  return (kept ?? []).filter((k) => existsSync(join(dir, ...k.split("/"))));
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

  /**
   * The status issue's state for the guide (w8-status-write, D-W8-44): the status board sets it
   * at compose (`StatusBoard.guideState`); unset, the guide reads the Settings switch alone.
   */
  statusIssueState: ((project: Pick<ProjectRow, "settings">) => StatusIssueState) | undefined;

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
   * project whose status pull request is off, once a session wrote it, or (W15-01 fix-up) whose
   * last status stayed in the app because another project's status pull request was open
   * (`STATUS_HELD_MARK`); null otherwise (the repository's, as merged, or the project's folder).
   * Before, the second project's Docs tab read "not written yet" while its status was kept.
   */
  statusDocRoot(project: ProjectRow): string | null {
    if (!parseRepoRef(project.repos[0] ?? "") || isAbsolute(project.repos[0] ?? "")) return null;
    const dir = this.statusInAppDir(project.id);
    if (!existsSync(join(dir, fromPosix(STATUS_DOC)))) return null;
    // D9: a together project's status is always the app's (it writes none to the repository).
    if (!statusPullRequestOn(project) || isTogether(project)) return dir;
    return existsSync(join(dir, STATUS_HELD_MARK)) ? dir : null;
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
   * The install marker this computer's copy of the repository holds (`.forerunner/project.json`
   * on the default branch as last refreshed), read as a file, or null (d1109-onerepo-link).
   */
  copyMarker(projectId: string): string | null {
    try {
      return readFileSync(join(this.copyDir(projectId), fromPosix(INSTALL_MARKER_FILE)), "utf8");
    } catch {
      return null;
    }
  }

  /** W15-01 through the index: whether the repository's unmarked docs pull requests are its. */
  private ownsUnmarked(project: ProjectRow, repo: RepoRef): Promise<boolean> {
    return ownsUnmarkedDocs(this.deps.store, project, repo, this.copyMarker(project.id));
  }

  /**
   * OR-09 (L3-github-5): why the project's status was last kept in the app although its status
   * pull request is on: the open status pull request that held it, by its number and the
   * project its mark names (null for an unmarked one); null when nothing held it.
   */
  statusHeld(project: ProjectRow): { prNumber: number | null; projectId: string | null } | null {
    if (!statusPullRequestOn(project)) return null;
    let text: string;
    try {
      text = readFileSync(join(this.statusInAppDir(project.id), STATUS_HELD_MARK), "utf8");
    } catch {
      return null;
    }
    try {
      const o = JSON.parse(text) as { pr?: unknown; project?: unknown };
      return {
        prNumber: typeof o.pr === "number" ? o.pr : null,
        projectId: typeof o.project === "string" ? o.project : null,
      };
    } catch {
      // A mark an earlier version wrote: held, by whom is not known.
      return { prNumber: null, projectId: null };
    }
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
    const dir = this.copyDir(project.id);
    const record = readCopyRecord(dir);
    const folder = this.localOnlyFolder(project);
    return {
      updatedAt: record?.updatedAt ?? null,
      localOnly: folder
        ? { folder, line: LOCAL_ONLY_LINE }
        : record?.localOnly === "tracked"
          ? { folder: null, line: LOCAL_ONLY_TRACKED_LINE }
          : record?.localOnly === "taken"
            ? {
                folder: null,
                // True now: the kept files still there, named inside the folder.
                line: localOnlyTakenLine(
                  stillThere(dir, record.kept).map((k) =>
                    k.startsWith(`${LOCAL_ONLY_DIR}/`) ? k.slice(LOCAL_ONLY_DIR.length + 1) : k,
                  ),
                ),
              }
            : null,
      // R-copystuck: the copy stopped following what is merged, and why.
      ...(record?.stopped
        ? { stopped: { ...record.stopped, line: copyStoppedLine(record.stopped) } }
        : {}),
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

  /** `<worktreeRoot>/previews/<project id>`: where a project's pull request preview lives. */
  previewRoot(projectId: string): string {
    return join(this.deps.worktreeRoot, PREVIEWS_DIR, safeSegment(projectId, "project"));
  }

  /**
   * The project's pull request preview on this computer now (`pr-<n>` under `previewRoot`, with
   * its record `preview.json`), or null. Reads the folder only (no git): true while it is there.
   */
  previewOf(
    projectId: string,
  ): { number: number; folder: string; combined: boolean; base: string } | null {
    const root = this.previewRoot(projectId);
    let record: { number?: unknown; combined?: unknown; base?: unknown };
    try {
      record = JSON.parse(readFileSync(join(root, PREVIEW_RECORD), "utf8")) as typeof record;
    } catch {
      return null;
    }
    if (typeof record.number !== "number" || !Number.isInteger(record.number)) return null;
    const folder = join(root, `pr-${record.number}`);
    if (!existsSync(join(folder, ".git"))) return null;
    return {
      number: record.number,
      folder,
      combined: record.combined !== false,
      base: typeof record.base === "string" ? record.base : "main",
    };
  }

  /**
   * "Open this version" on a pull request that waits to be merged (merged-actions, the owner's
   * decision of 2026-11-02, "pr_preview"): the pull request's files on this computer to try
   * before merging. Under the copy's lock (`withCopy`), the copy is fetched and the pull
   * request's head checked out into a folder beside it (`previewRoot`/`pr-<n>`, a second working
   * folder of the copy's clone with no branch: `git worktree add --detach`), replacing any earlier
   * preview of the project. When the default branch moved past what the pull request started
   * from, it is merged in there (never pushed), so the folder holds what merging would give;
   * when the two do not merge cleanly the folder keeps the pull request's own version and
   * `combined` is false. Nothing runs there, and the project's Local only folder is not copied
   * into it. Dropped when the pull request is merged or closed (`dropPreview`).
   */
  async previewPullRequest(
    project: ProjectRow,
    pr: { number: number; headRef: string; headSha: string },
  ): Promise<{ folder: string; number: number; combined: boolean; base: string }> {
    const target = await this.deps.repoFor(project);
    if (!target)
      throw new ForerunnerError("not_found", "This project has no repository to preview.");
    if (!existsSync(join(this.copyDir(project.id), ".git"))) await this.refreshCopy(project);
    return this.withCopy(project.id, async (dir) => {
      const auth = gitAuthFor(await resolveGitToken(this.deps.token), target.clone);
      const git = this.gitOf(dir, auth);
      await git.fetch();
      // The preview reads the copy's config: our line endings there too (R-copystuck).
      await this.pinLineEndings(git);
      if (!(await git.hasRef(pr.headSha))) await git.fetchRef(`refs/pull/${pr.number}/head`);
      if (!(await git.hasRef(pr.headSha)))
        throw new ForerunnerError(
          "not_found",
          `#${pr.number}'s version is not on GitHub any more: open it on GitHub.`,
        );
      await this.removePreviews(git, project.id);
      const root = this.previewRoot(project.id);
      mkdirSync(root, { recursive: true });
      const folder = join(root, `pr-${pr.number}`);
      await git.worktreeAdd(folder, pr.headSha);
      let combined = true;
      const base = `origin/${target.base}`;
      if ((await git.hasRef(base)) && !(await git.isAncestor(base, pr.headSha))) {
        const there = new GitOps({
          cwd: folder,
          untranslated: true,
          identity: this.deps.identity ?? WORKSPACE_IDENTITY,
        });
        const merged = await there.mergeFrom(
          base,
          `Preview of #${pr.number} merged with ${target.base}`,
          { noFastForward: true },
        );
        combined = merged.ok;
      }
      writeFileSync(
        join(root, PREVIEW_RECORD),
        `${JSON.stringify({ number: pr.number, combined, base: target.base, sha: pr.headSha })}\n`,
        "utf8",
      );
      this.logger.info("pull request preview", { projectId: project.id, pr: pr.number, combined });
      return { folder, number: pr.number, combined, base: target.base };
    });
  }

  /**
   * Removes the project's pull request preview (whichever it is, or only when it is of
   * `number`): the pull request was merged or closed. Under the copy's lock. True when one went.
   */
  async dropPreview(projectId: string, number?: number): Promise<boolean> {
    const now = this.previewOf(projectId);
    if (!now || (number !== undefined && now.number !== number)) return false;
    return this.withCopy(projectId, async (dir) => {
      if (existsSync(join(dir, ".git")))
        await this.removePreviews(this.gitOf(dir, undefined), projectId);
      rmSync(this.previewRoot(projectId), { recursive: true, force: true });
      this.logger.info("pull request preview removed", { projectId, pr: now.number });
      return true;
    });
  }

  /** Every preview folder of the project, removed from the copy's clone (inside `withCopy`). */
  private async removePreviews(git: GitOps, projectId: string): Promise<void> {
    const root = this.previewRoot(projectId);
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) if (/^pr-\d+$/.test(name)) await git.worktreeRemove(join(root, name));
    rmSync(join(root, PREVIEW_RECORD), { force: true });
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
    opts: { head?: string; base?: string } = {},
  ): Promise<{ refreshed: boolean }> {
    // The watcher's read names the head and its branch: a copy already there needs no call to
    // the host at all (it reads the head every poll, for every repository project).
    const { head, base } = opts;
    if (
      head &&
      base &&
      repositoryOf(project) &&
      existsSync(join(this.copyDir(project.id), ".git"))
    ) {
      const there = await this.withCopy(project.id, async (dir) => {
        const git = this.gitOf(dir, undefined);
        const at = await git.resolveRef("HEAD").catch(() => null);
        const on = await git.currentBranch().catch(() => "");
        if (at !== head || on !== base) return false;
        await this.settle(git, dir, { base }, { checkout: false });
        return true;
      });
      if (there) return { refreshed: false };
    }
    const target = await this.deps.repoFor(project);
    if (!target) return { refreshed: false };
    return this.withCopy(project.id, async (dir) => {
      const auth = gitAuthFor(await resolveGitToken(this.deps.token), target.clone);
      const git = this.gitOf(dir, auth);
      if (head && existsSync(join(dir, ".git"))) {
        const at = await git.resolveRef("HEAD").catch(() => null);
        const on = await git.currentBranch().catch(() => "");
        if (at === head && on === target.base) {
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
    let guideKey: string | null = null;
    // D9 (d1109-onerepo-link): a project worked on together with another Forerunner writes
    // nothing to the repository by itself (no marker, no doc set, no pull request): its docs and
    // marker are the other Forerunner's. Only this computer's copy is brought along (nothing
    // pushed), so the Docs and Files tabs read the repository.
    if (isTogether(project)) {
      try {
        await this.refreshCopy(project);
      } catch (e) {
        this.logger.warn("this computer's copy of the repository not made", {
          projectId: project.id,
          error: errorMessage(e),
        });
      }
      const together: DocsScaffoldOutcome = {
        location: "repo",
        prUrl: null,
        created: [],
        existing: [],
        together: true,
      };
      await this.record(project, { ...together, scaffolded_at: this.deps.clock.nowIso() });
      return together;
    }
    try {
      const target = await this.deps.repoFor(project);
      if (!target) {
        const dir = this.workspaceDir(project.id);
        mkdirSync(dir, { recursive: true });
        // W8-guide-1: a project kept in a folder gets its guide too (no GitHub part).
        const res = await scaffoldDocs(dir, {
          ...info,
          guide: guideFactsOf(project, {
            statusIssue: this.statusIssueState,
            dir,
            defaultBranch: null,
          }),
        });
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
        outcome = await this.withCopy(project.id, async () => {
          const out = await this.scaffoldInCopy(project, target);
          // W8-guide-1: the facts the guide went out with, so the session end finds it current.
          if (!out.stopped) guideKey = this.guideKeyIn(project, target.base);
          return out;
        });
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
      ...(guideKey ? { guide_key: guideKey } : {}),
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

  /**
   * The scaffold of a repository project, in its copy (under the copy's lock). L4-github-102
   * (D-L4-24): the branch is one the project owns (`scaffoldBranchFor`); without an open
   * scaffold pull request of this project it starts from the default branch, and a branch of
   * this project's that is on GitHub already (a merged or closed pull request's) is replaced
   * with a lease, as `fr/status` is. A take-over while this project's own scaffold pull request
   * is open rebuilds that branch on the default branch (C4L-2). The copy goes back to the default
   * branch afterwards, also when a step failed.
   */
  private async scaffoldInCopy(
    project: ProjectRow,
    target: ProjectRepoTarget,
  ): Promise<DocsScaffoldOutcome> {
    // W15-01, L4i-left-2: an open scaffold PR that is not this project's (another project's, or
    // one that names no project and whose branch's marker does not name this one) is never
    // written to or commented on. The branch's marker is read from GitHub's copy of the branch
    // once the copy is fetched (`scaffoldBranchFor`), before `checkout` asks.
    const branchMarkers = new Map<string, string | null>();
    const ours = (pr: PullRequestInfo) =>
      isProjectDocsPr(project, pr, { branchMarker: branchMarkers.get(pr.head.ref) ?? null });
    const out = await this.checkout(
      project,
      target,
      (git) => this.scaffoldBranchFor(project, target, git, ours, branchMarkers),
      { ours, fresh: async (open) => !open },
    );
    const { git, dir } = out;
    let outcome: DocsScaffoldOutcome;
    try {
      outcome = await this.scaffoldOnBranch(project, target, out);
    } catch (e) {
      await this.settle(git, dir, target).catch((err: unknown) =>
        this.logger.warn("this computer's copy was not put back on the default branch", {
          projectId: project.id,
          error: errorMessage(err),
        }),
      );
      throw e;
    }
    await this.settle(git, dir, target);
    return outcome;
  }

  /**
   * The branch the scaffold writes on (D-L4-24), or null when every candidate is someone else's:
   * the first of `scaffoldBranchesOf` that holds this project's open scaffold pull request, is
   * not on GitHub, or is this project's own (its marker names the project). `fr/docs-scaffold`
   * with another project's open pull request is returned as it is: `checkout` names it
   * `foreign` and nothing is written (W15-01).
   */
  private async scaffoldBranchFor(
    project: ProjectRow,
    target: ProjectRepoTarget,
    git: GitOps,
    ours: (pr: PullRequestInfo) => boolean,
    branchMarkers: Map<string, string | null>,
  ): Promise<string | null> {
    const ids = projectIdsOf(project).map((id) => id.toLowerCase());
    for (const branch of scaffoldBranchesOf(project)) {
      const open = await this.deps.host.listPullRequests(target.repo, {
        state: "open",
        head: branch,
      });
      // L4i-left-2: the branch's own marker, the evidence for an open pull request that names
      // no project (read before `ours` is asked about it).
      const marker = (await git.hasRef(`origin/${branch}`))
        ? parseInstallMarker((await git.fileAt(`origin/${branch}`, INSTALL_MARKER_FILE)) ?? "")
        : null;
      branchMarkers.set(branch, marker?.project ?? null);
      if (open.length) {
        if (branch === DOCS_SCAFFOLD_BRANCH || open.every(ours)) return branch;
        continue;
      }
      if (!(await git.hasRef(`origin/${branch}`))) return branch;
      if (marker && ids.includes(marker.project.toLowerCase())) return branch;
      this.logger.info("a scaffold branch on the repository is not this project's: left as it is", {
        projectId: project.id,
        branch,
      });
    }
    return null;
  }

  /** The scaffold's write on the branch `checkout` gave (the copy's lock is held). */
  private async scaffoldOnBranch(
    project: ProjectRow,
    target: ProjectRepoTarget,
    out: Awaited<ReturnType<ProjectDocs["checkout"]>>,
  ): Promise<DocsScaffoldOutcome> {
    const info = { name: project.name, goal: project.goal, repos: project.repos };
    const { git, dir, existingPr, first, foreign, branch } = out;
    if (!branch) {
      this.logger.info(
        "standard docs not scaffolded: every scaffold branch on the repository is another's",
        { projectId: project.id },
      );
      return {
        location: "repo",
        prUrl: null,
        created: [],
        existing: [],
        stopped: "branches_taken",
      };
    }
    if (foreign) {
      this.logger.info(
        "standard docs not scaffolded: a docs pull request that is not this project's is open",
        {
          projectId: project.id,
          branch,
          prUrl: foreign.htmlUrl,
        },
      );
      return {
        location: "repo",
        branch,
        prUrl: null,
        created: [],
        existing: [],
        stopped: "pull_request_open",
      };
    }
    if (first) {
      // An empty repository: the set went in as its first commit on the default branch.
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
    const remote = await git.hasRef(`origin/${branch}`);
    // C4L-2: a take-over while this project's own scaffold pull request is open. The branch is
    // rebuilt on the default branch with the files it added (a person's edits on it included),
    // so the pull request's only change to the marker is the replaced one, and it merges.
    const rebuilt = existingPr
      ? await this.rebuildForTakeOver(project, target, git, dir, branch)
      : false;
    // W8-guide-1: the guide rendered from its facts (this copy's checks, the default branch).
    const res = await scaffoldDocs(dir, {
      ...info,
      guide: guideFactsOf(project, {
        statusIssue: this.statusIssueState,
        dir,
        defaultBranch: target.base,
      }),
    });
    const marker = await this.mark(project, dir);
    const written = [
      ...res.created,
      ...(res.updated ?? []),
      ...(marker.status === "created" || marker.status === "replaced" ? [marker.path] : []),
    ];
    // W8-guide-2: Forerunner's untouched status template, taken out (said in the words below).
    const removed = res.removed ?? [];
    // An open scaffold PR is this project's here (`foreign` above, W15-01): its docs PR.
    let prUrl = existingPr ? existingPr.htmlUrl : null;
    if (written.length || removed.length) {
      const list = [
        ...written.map((p) => `- ${p}`),
        ...removed.map((p) => `- ${p} (taken out)`),
      ].join("\n");
      const markerNote =
        marker.status === "created"
          ? `\n\n\`${marker.path}\` marks the repository as managed by a Forerunner project (spec A.4); a source scan by any install reads it.`
          : marker.status === "replaced"
            ? `\n\n${tookOverLine(marker.was.name, project.name)}`
            : "";
      const guideNote = guideWords(res, removed);
      await git.commitAll(`docs: scaffold the standard doc set\n\n${list}`);
      // D-L4-24: a branch this project owns that GitHub already has (a merged or closed pull
      // request's, or the open one rebuilt) is replaced with a lease on the head just fetched;
      // never the default branch (GitOps refuses), never a branch of another's.
      await git.push(branch, {
        force: remote && (rebuilt || !existingPr),
        defaultBranch: target.base,
      });
      if (existingPr) {
        await this.deps.host.commentOnPullRequest(
          target.repo,
          existingPr.number,
          rebuilt
            ? `Rebuilt on ${target.base} for project ${project.name}:\n${list}${markerNote}${guideNote}`
            : `Added the missing standard docs for project ${project.name}:\n${list}${markerNote}${guideNote}`,
        );
      } else {
        const pr = await this.deps.host.createPullRequest(target.repo, {
          title: "docs: scaffold the standard project doc set",
          // The project it is for in the hidden mark (W15-01, W15-08), never as visible text.
          body: `Standard project docs for ${project.name} (spec G.5), written from templates for the files the repository lacked:\n${list}${markerNote}${guideNote}\n\nExisting files were left as they are${res.existing.length ? ` (${res.existing.join(", ")})` : ""}. Opened by Forerunner.\n\n${docsPrMarker(project)}`,
          head: branch,
          base: target.base,
        });
        prUrl = pr.htmlUrl;
      }
    }
    return {
      location: "repo",
      branch,
      prUrl,
      created: res.created,
      existing: res.existing,
      ...(res.updated?.length ? { updated: res.updated } : {}),
      ...(removed.length ? { removed } : {}),
      marker,
    };
  }

  /**
   * C4L-2 (ADR 0117 amended 2026-11-23): when this project took the repository over and its own
   * open scaffold pull request still carries the marker it took over, the copy is put on the
   * default branch with the files that branch added (the marker left as the default branch has
   * it), so `mark()` replaces exactly that marker and the push replaces the branch with a lease.
   * False when there is nothing to rebuild.
   */
  private async rebuildForTakeOver(
    project: ProjectRow,
    target: ProjectRepoTarget,
    git: GitOps,
    dir: string,
    branch: string,
  ): Promise<boolean> {
    const took = (tookOverOf(project)?.projects ?? []).map((id) => id.toLowerCase());
    if (!took.length) return false;
    const onBranch = parseInstallMarker(
      (await git.fileAt(`origin/${branch}`, INSTALL_MARKER_FILE)) ?? "",
    );
    if (!onBranch || !took.includes(onBranch.project.toLowerCase())) return false;
    const base = `origin/${target.base}`;
    // L4i-left-14: a file the default branch changed after the branch left it (another
    // Forerunner's merged docs, D9) keeps the default branch's version; only what the branch
    // alone changed is carried over. Before, the branch's copy replaced main's newer one.
    const forkedAt = await git.mergeBase(base, `origin/${branch}`);
    const added = new Map<string, string>();
    const keptMain: string[] = [];
    for (const file of await git.changedFiles(base, `origin/${branch}`)) {
      if (file === INSTALL_MARKER_FILE) continue;
      const text = await git.fileAt(`origin/${branch}`, file);
      if (text === null) continue;
      if (forkedAt) {
        const was = await git.fileAt(forkedAt, file);
        const now = await git.fileAt(base, file);
        if (now !== null && now !== was && now !== text) {
          keptMain.push(file);
          continue;
        }
      }
      added.set(file, text);
    }
    await this.switchCopy(git, dir, branch, base);
    for (const [file, text] of added) {
      const abs = join(dir, fromPosix(file));
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, text, "utf8");
    }
    this.logger.info("scaffold branch rebuilt on the default branch for a take-over", {
      projectId: project.id,
      branch,
      files: added.size,
      keptFromDefaultBranch: keptMain,
    });
    return true;
  }

  async writeSessionStatus(input: {
    project: ProjectRow;
    session: SessionRow;
    update: SessionStatusUpdate;
  }): Promise<SessionStatusOutcome> {
    const { project, session } = input;
    // The entry is named by when the session started, never its id (W15-08, L3-github-6).
    const update: StatusUpdate = {
      ...input.update,
      startedAt: session.started_at ?? session.created_at ?? null,
      state: await this.projectState(project.id),
    };
    const target = await this.deps.repoFor(project);
    if (!target) return this.statusInFolder(project, session, update);
    // C-57: unless the person turned the status pull request on, a repository project's status
    // stays in the app: one PR to merge after every session was noise, even for one task.
    // D9: a project worked on together writes nothing to the repository: its status stays in
    // the app, whatever the setting (the repository's docs are the other Forerunner's).
    if (!statusPullRequestOn(project) || isTogether(project))
      return this.statusInApp(project, update);
    // Forerunner's own status branch, never a task's: the critic accepted the task's branch,
    // and a commit after the review would put a file it never saw into the reviewed PR. Under
    // the copy's lock (merged-copy): a refresh never moves the clone off the branch mid-write.
    const branch = STATUS_BRANCH;
    // W15-01: `fr/status` is one branch per repository, so another project on the same
    // repository may have its status pull request open there; that one is never written to or
    // commented on (live check 2: a second project's session pushed its status into the first
    // project's PR). Its own is told by the hidden mark, or an unmarked one by being the one
    // project linked (an earlier version's PR). One PR at a time (owner question W15-112).
    const soleLinked = await this.ownsUnmarked(project, target.repo);
    const written = await this.withCopy(project.id, async () => {
      const { git, dir, existingPr, foreign } = await this.checkout(project, target, branch, {
        // A status PR that was merged or closed: the branch starts again from the default one.
        fresh: async (open) => !open,
        ours: (pr) => isProjectStatusPr(project, pr, { soleLinked }),
      });
      if (foreign) {
        await this.settle(git, dir, target);
        return { foreign, commit: null, prUrl: null, res: null };
      }
      const res = await writeStatusUpdate(dir, update);
      // The session by when it started, never its id (W15-08: no ids in what a person reads).
      const named = sessionWords(session.started_at ?? session.created_at);
      const commit = await git.commitAll(`docs: status after ${named}`);
      let prUrl = existingPr?.htmlUrl ?? null;
      if (commit.committed) {
        // The branch is Forerunner's alone; without an open PR it was started again from the
        // default branch, so the host's old copy (a merged or closed PR's) is replaced.
        await git.push(branch, { force: !existingPr, defaultBranch: target.base });
        const body = `Status update of ${named}:\n\n- Done: ${line(update.done)}\n- In flight: ${line(update.inFlight)}\n- Blocked: ${line(update.blocked)}\n- Next: ${line(update.next)}`;
        if (existingPr) {
          await this.deps.host.commentOnPullRequest(target.repo, existingPr.number, body);
        } else {
          const pr = await this.deps.host.createPullRequest(target.repo, {
            title: "docs: project status",
            body: `${body}\n\nForerunner keeps docs/status.md on this branch and adds each session's update to this pull request until it is merged. Opened by Forerunner.\n\n${docsPrMarker(project)}`,
            head: branch,
            base: target.base,
          });
          prUrl = pr.htmlUrl;
        }
      }
      await this.settle(git, dir, target);
      return { foreign: null, commit, prUrl, res };
    });
    const { foreign, commit, prUrl, res } = written;
    if (foreign || !commit || !res) {
      // Its status stays in the app this time (C-57's place for it); the next session's end
      // tries the pull request again.
      this.logger.info(
        "status pull request not written: another project's status pull request is open",
        { projectId: project.id, branch, prUrl: foreign?.htmlUrl ?? null },
      );
      return this.statusInApp(project, update, { refresh: false, held: foreign });
    }
    // Its own status pull request has it again: the app's copy is no longer read first.
    rmSync(join(this.statusInAppDir(project.id), STATUS_HELD_MARK), { force: true });
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
   * A repository project's status kept in the app (`STATUS_IN_APP_DIR`, C-57), where the Docs
   * tab reads it: its status pull request is off, or another project's is open on `fr/status`
   * (W15-01, `held`: marked so with `STATUS_HELD_MARK`). `refresh`: the copy is refreshed here
   * too (nothing pushed).
   */
  private async statusInApp(
    project: ProjectRow,
    update: StatusUpdate,
    opts: { refresh?: boolean; held?: Pick<PullRequestInfo, "number" | "body"> | null } = {},
  ): Promise<SessionStatusOutcome> {
    const dir = this.statusInAppDir(project.id);
    mkdirSync(dir, { recursive: true });
    const res = await writeStatusUpdate(dir, update);
    const mark = join(dir, STATUS_HELD_MARK);
    // OR-09: which pull request held it and the project its mark names (null: unmarked), so the
    // Docs row says why, after a restart too.
    if (opts.held)
      writeFileSync(
        mark,
        `${JSON.stringify({
          pr: opts.held.number,
          project: readForerunnerMarker(opts.held.body)?.project ?? null,
        })}\n`,
        "utf8",
      );
    else rmSync(mark, { force: true });
    // The status write was also what kept this computer's copy of the repository current;
    // without it a project made from a brief had no copy at all (its Docs tab said README.md
    // was missing, its Files tab "Nothing written yet") and a merge never showed (review of
    // fix/decisions, 2026-11-02). The copy is refreshed here, with nothing pushed.
    if (opts.refresh !== false) {
      try {
        await this.refreshCopy(project);
      } catch (e) {
        // The status is in the app either way; the copy is read as it was.
        this.logger.warn("this computer's copy of the repository not refreshed", {
          projectId: project.id,
          error: errorMessage(e),
        });
      }
    }
    return { location: "app", dir, path: res.path, created: res.created };
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
      const git = new GitOps({
        cwd: dir,
        identity: this.deps.identity ?? WORKSPACE_IDENTITY,
        untranslated: true,
      });
      if (!existsSync(join(dir, ".git"))) await git.init("main");
      // W15-11: a project folder made before git.init pinned our line endings says so too; a
      // failure is logged, never fatal (the commit goes on).
      else
        await git.pinLineEndings().catch((e: unknown) =>
          this.logger.warn("line endings not pinned in the project folder", {
            projectId: project.id,
            error: errorMessage(e),
          }),
        );
      ensureWorkspaceGitignore(dir);
      // W6-26: a review's try folder a dead daemon left is never committed with the session.
      excludeNeverPushed(dir, [TRY_DIR]);
      const done = update.done.length
        ? `Did ${update.done.map((t) => `"${t}"`).join(", ")}`
        : "Work of the session";
      // The session by when it started, never its id or a raw instant (L3-run-11, W15-08): the
      // body is what plain `git log` shows the person in their folder; the commit has its date.
      const made = await git.commitAll(
        `${done.slice(0, 200)}\n\nCommitted by Forerunner at the end of ${sessionWords(session.started_at ?? session.created_at)}.`,
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
   * W8-guide-1 (the owner's "kept current by Forerunner"): the repository guide brought up to
   * its facts, at the end of each session and whenever one of its facts changes (w8-status-write
   * calls it when the status issue's state changes). Only the Forerunner that made the project
   * writes it: a project worked on together with another Forerunner never does (D-W8-9).
   *
   * Cheap when nothing changed: this computer's copy (on the default branch, as the session's end
   * just refreshed it) is compared with the rendered facts, with no git and no GitHub call.
   * Otherwise one docs pull request at a time: while this project's own docs pull request from
   * the plan (`fr/intake-...`) is open, nothing (the next end, once it is merged); else the
   * scaffold's own branch, which updates this project's open scaffold pull request in place or
   * opens one (`scaffoldInCopy`, with every ownership rule of L4i-left-2). A run that finds the
   * guide already on that open pull request writes nothing, so a restart opens no second one.
   * A project kept in a folder has its guide rewritten there (nothing to push).
   */
  async refreshGuide(given: ProjectRow): Promise<{ changed: boolean; prUrl: string | null }> {
    const none = { changed: false, prUrl: null };
    const project = (await this.deps.store.project.get(given.id)) ?? given;
    if (isTogether(project) || project.status === "archived") return none;
    const target = await this.deps.repoFor(project);
    if (!target) {
      const dir = this.workspaceDir(project.id);
      if (!existsSync(dir)) return none;
      const facts = guideFactsOf(project, {
        statusIssue: this.statusIssueState,
        dir,
        defaultBranch: null,
      });
      if (guideIsCurrentIn(dir, facts)) return none;
      const res = await scaffoldDocs(dir, {
        name: project.name,
        goal: project.goal,
        repos: project.repos,
        guide: facts,
      });
      return { changed: res.created.length + (res.updated?.length ?? 0) > 0, prUrl: null };
    }
    const docs = (project.summary_cache?.docs ?? {}) as { guide_key?: unknown };
    const copy = this.copyDir(project.id);
    // The facts the guide last went out with: unchanged, nothing to read or write.
    if (docs.guide_key === this.guideKeyIn(project, target.base)) return none;
    const facts = guideFactsOf(project, {
      statusIssue: this.statusIssueState,
      dir: copy,
      defaultBranch: target.base,
    });
    if (existsSync(join(copy, ".git")) && guideIsCurrentIn(copy, facts)) {
      await this.record(project, { ...docs, guide_key: guideKeyOf(facts) });
      return none;
    }
    // The intake's docs pull request carries the guide while it is open (`writeDocSet`).
    const open = await this.deps.host.listPullRequests(target.repo, { state: "open" });
    if (open.some((pr) => /^fr\/intake-.+-docs$/.test(pr.head.ref) && isProjectDocsPr(project, pr)))
      return none;
    let after: string | null = null;
    const out = await this.withCopy(project.id, async () => {
      const res = await this.scaffoldInCopy(project, target);
      if (!res.stopped) after = this.guideKeyIn(project, target.base);
      return res;
    });
    const changed =
      out.created.length + (out.updated?.length ?? 0) + (out.removed?.length ?? 0) > 0 ||
      (!!out.prUrl && out.prUrl !== this.recordedDocsPr(project));
    await this.record(project, {
      ...((await this.deps.store.project.get(project.id))?.summary_cache?.docs as object),
      ...(out.prUrl ? { pr_url: out.prUrl } : {}),
      ...(after ? { guide_key: after } : {}),
      guide_at: this.deps.clock.nowIso(),
    });
    this.logger.info("repository guide checked", {
      projectId: project.id,
      prUrl: out.prUrl ?? null,
      stopped: out.stopped ?? null,
    });
    return { changed, prUrl: out.prUrl ?? null };
  }

  /** The key of the guide's facts as this computer's copy (on `base`) gives them now. */
  private guideKeyIn(project: ProjectRow, base: string): string {
    return guideKeyOf(
      guideFactsOf(project, {
        statusIssue: this.statusIssueState,
        dir: this.copyDir(project.id),
        defaultBranch: base,
      }),
    );
  }

  /** The docs pull request the project's scaffold recorded, or null. */
  private recordedDocsPr(project: ProjectRow): string | null {
    const url = (project.summary_cache?.docs as { pr_url?: unknown } | undefined)?.pr_url;
    return typeof url === "string" ? url : null;
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
    // Only this project's docs PRs (L-16, W15-01): another project's on the same repository is
    // not where this project's docs wait. L4i-left-2: one that names no project is this
    // project's only when its branch's own marker names it (read once the copy is fetched).
    const prs = (await this.deps.host.listPullRequests(target.repo, { state: "open" })).filter(
      (p) => isDocsBranch(p.head.ref),
    );
    // The fetch under the copy's lock (merged-copy): never beside a refresh or a docs write.
    return this.withCopy(project.id, async (dir) => {
      const git = this.gitOf(dir, gitAuthFor(await resolveGitToken(this.deps.token), target.clone));
      await git.fetch();
      const out: DocInPullRequest[] = [];
      for (const pr of prs) {
        if (!(await git.hasRef(`origin/${pr.head.ref}`))) continue;
        const branchMarker =
          parseInstallMarker((await git.fileAt(`origin/${pr.head.ref}`, INSTALL_MARKER_FILE)) ?? "")
            ?.project ?? null;
        if (!isProjectDocsPr(project, pr, { branchMarker })) continue;
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
   * `ours` (W15-01): an open pull request on the branch that is not this project's makes the
   * branch another project's for now: the copy is not switched to it and `foreign` names it, so
   * the caller writes nothing there (a push to the branch would land in that pull request).
   * `branch` may be a choice made once the copy is fetched (the scaffold's, D-L4-24); null
   * there means no branch may be written, and the copy stays where it is.
   */
  private async checkout(
    project: ProjectRow,
    target: ProjectRepoTarget,
    pick: string | ((git: GitOps) => Promise<string | null>),
    opts: {
      fresh?: (openPr: boolean) => Promise<boolean>;
      ours?: (pr: PullRequestInfo) => boolean;
    } = {},
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
          guide: guideFactsOf(project, {
            statusIssue: this.statusIssueState,
            dir: scratch,
            defaultBranch: target.base,
          }),
        });
        const marker = await this.mark(project, scratch);
        first = { created: res.created, marker };
        return `docs: start the repository with the standard doc set\n\nThe repository was empty; Forerunner made this first commit so the project's work has a branch to start from:\n${res.created.map((p) => `- ${p}`).join("\n")}`;
      },
    });
    const branch = typeof pick === "string" ? pick : await pick(git);
    if (!branch)
      return {
        git,
        dir,
        branch: null,
        existingPr: null,
        foreign: null as PullRequestInfo | null,
        first: first as { created: string[]; marker: InstallMarkerWrite | null } | null,
      };
    const open = await this.deps.host.listPullRequests(target.repo, {
      state: "open",
      head: branch,
    });
    const foreign = opts.ours ? (open.find((pr) => !opts.ours?.(pr)) ?? null) : null;
    if (foreign)
      return {
        git,
        dir,
        branch,
        existingPr: null,
        foreign,
        first: first as { created: string[]; marker: InstallMarkerWrite | null } | null,
      };
    const existingPr = open[0] ?? null;
    const fresh = opts.fresh ? await opts.fresh(!!existingPr) : false;
    const from =
      !fresh && (await git.hasRef(`origin/${branch}`))
        ? `origin/${branch}`
        : `origin/${target.base}`;
    await this.switchCopy(git, dir, branch, from);
    return {
      git,
      dir,
      branch: branch as string | null,
      existingPr,
      foreign: null as PullRequestInfo | null,
      first: first as { created: string[]; marker: InstallMarkerWrite | null } | null,
    };
  }

  /**
   * The git of the copy, with the token scoped to the repository's origin (ADR 0069) and the
   * push guard on (merged-copy): no docs write ever uploads Local only or a try folder. Its
   * messages are untranslated (TM-6): `copyStoppedOf` reads git's words for why the copy
   * stopped following, and a person's git in another language left the Files line without
   * the file names.
   */
  private gitOf(dir: string, auth: GitAuth | undefined): GitOps {
    return new GitOps({
      cwd: dir,
      ...(auth ? { auth } : {}),
      ...(this.deps.identity ? { identity: this.deps.identity } : {}),
      neverPush: NEVER_PUSHED,
      untranslated: true,
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
    target: Pick<ProjectRepoTarget, "base">,
    opts: { checkout?: boolean } = {},
  ): Promise<void> {
    const base = `origin/${target.base}`;
    // The copy's own config says our line endings, also in a copy cloned before the clone did
    // (R-copystuck): the person's own git there writes a file it puts back as ours reads it.
    await this.pinLineEndings(git);
    const hasBase = await git.hasRef(base);
    // A copy that could not be put on the default branch (a file the person changed in it that
    // the merge also changed) keeps the time of its last real update, and says why (R-copystuck).
    const stopped =
      hasBase && opts.checkout !== false ? await this.backToBase(git, dir, target) : null;
    const moved = !stopped;
    const before = readCopyRecord(dir);
    const tracked = hasBase ? ((await git.trackedUnder(base, [LOCAL_ONLY_DIR])) ?? []) : [];
    // Never removes the Local only line an earlier settle wrote: when the repository starts
    // tracking such a folder, the person's own files left in it stay out of git.
    excludeNeverPushed(dir, tracked.length ? [TRY_DIR] : NEVER_PUSHED);
    let localOnly: CopyRecord["localOnly"] = "none";
    if (tracked.length)
      localOnly = (await this.personsFilesIn(git, dir, tracked)) ? "taken" : "tracked";
    else {
      try {
        mkdirSync(join(dir, LOCAL_ONLY_DIR), { recursive: true });
        localOnly = "folder";
      } catch (e) {
        this.logger.warn("the Local only folder was not made", { error: errorMessage(e) });
      }
    }
    // The person's files kept beside the repository's are named while the folder is taken.
    const kept = localOnly === "taken" ? stillThere(dir, before?.kept) : [];
    const record: CopyRecord = {
      ...(moved || !before
        ? {
            updatedAt: this.deps.clock.nowIso(),
            head: hasBase ? await git.resolveRef(base) : null,
          }
        : { updatedAt: before.updatedAt, head: before.head }),
      localOnly,
      ...(kept.length ? { kept } : {}),
      ...(stopped ? { stopped } : {}),
    };
    try {
      writeFileSync(join(dir, ".git", COPY_RECORD), JSON.stringify(record), "utf8");
    } catch (e) {
      this.logger.warn("the copy's record was not written", { error: errorMessage(e) });
    }
  }

  /**
   * `GitOps.pinLineEndings` in the copy (R-copystuck, ADR 0113): its `.git/config` says
   * `core.autocrlf=false`, which a preview (a working folder of the same clone) reads too, so
   * the person's own git there (Git for Windows: `core.autocrlf=true`) writes files as ours
   * reads them. Written once; a failure is logged and the step goes on.
   */
  private async pinLineEndings(git: GitOps): Promise<void> {
    try {
      await git.pinLineEndings();
    } catch (e) {
      this.logger.warn("the copy's line endings were not set in its git config", {
        error: errorMessage(e),
      });
    }
  }

  /**
   * The docs clone back on the default branch as the host has it, so what reads the clone (the
   * Docs and Files tabs, the chat's docs search) sees what is merged, not the last branch a
   * docs write used (before, the clone stayed on whichever PR branch was written last).
   */
  private async backToBase(
    git: GitOps,
    dir: string,
    target: Pick<ProjectRepoTarget, "base">,
  ): Promise<CopyStopped | null> {
    try {
      await this.switchCopy(git, dir, target.base, `origin/${target.base}`);
      return null;
    } catch (e) {
      this.logger.warn("docs clone not back on the default branch", { error: errorMessage(e) });
      return copyStoppedOf(e);
    }
  }

  /**
   * `checkout -B branch from` in the copy without losing a file of the person's (review of
   * merged-copy): what of Local only the checkout would replace is renamed "(yours)" first
   * (`keepLocalOnlyFromCheckout`); the checkout keeps ignored files, so anything still in the
   * way stops it (the copy then keeps the time of its last real update); a kept file the
   * repository's now matches byte for byte is dropped; the rest is recorded for the Files tab's
   * sentence. Every caller holds the copy's lock.
   */
  private async switchCopy(git: GitOps, dir: string, branch: string, from: string): Promise<void> {
    const moved = await keepLocalOnlyFromCheckout(git, dir, from);
    try {
      await git.createBranch(branch, from, { keepIgnored: true });
    } finally {
      const kept = dropKeptSame(dir, moved);
      const record = kept.length ? readCopyRecord(dir) : null;
      if (record) {
        const all = [...new Set([...(record.kept ?? []), ...kept.map((k) => k.kept)])];
        try {
          writeFileSync(
            join(dir, ".git", COPY_RECORD),
            JSON.stringify({ ...record, kept: all }),
            "utf8",
          );
        } catch (e) {
          this.logger.warn("the copy's record was not written", { error: errorMessage(e) });
        }
      }
    }
  }

  /**
   * Whether the copy's Local only folder holds a file of the person's (one neither its HEAD nor
   * the default branch tracks) while the repository tracks a folder of that name: the folder
   * was "taken", and the Files tab says the person's files in it stay on this computer.
   */
  private async personsFilesIn(git: GitOps, dir: string, tracked: string[]): Promise<boolean> {
    const theirs = new Set([
      ...tracked,
      ...((await git.trackedUnder("HEAD", [LOCAL_ONLY_DIR])) ?? []),
    ]);
    for (const rel of regularFilesUnder(join(dir, LOCAL_ONLY_DIR)).files.keys())
      if (!theirs.has(`${LOCAL_ONLY_DIR}/${rel}`)) return true;
    return false;
  }

  /**
   * The install marker (`.forerunner/project.json`, spec A.4, ADR 0056) beside the doc set,
   * naming this project, so a source scan by any install tells a managed repository or folder
   * from a fresh one. Another project's marker (a second install on the repository, or a second
   * project of this install on it) is reported on the outcome and never overwritten.
   */
  private async mark(project: ProjectRow, dir: string): Promise<InstallMarkerWrite> {
    // d1109-onerepo-link (ADR 0058 amended): a project that took the repository over replaces
    // the marker of exactly the projects it took over from; any other project's is kept.
    const marker = await writeInstallMarker(
      dir,
      { project: project.id, name: project.name },
      { replace: tookOverOf(project)?.projects ?? [] },
    );
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

/**
 * What a docs pull request (and its comment) says about the guide and the status template
 * (W8-guide-1, -2): GitHub text, so no id, no cost, no person's details.
 */
function guideWords(res: ScaffoldResult, removed: readonly string[]): string {
  const parts: string[] = [];
  if ([...res.created, ...(res.updated ?? [])].includes(GUIDE_FILE))
    parts.push(
      "`AGENTS.md` tells people and agents how to work on this repository, and `CLAUDE.md` points Claude Code to it. Forerunner keeps its part between the forerunner:guide marks current; text outside them stays as it was written.",
    );
  if (res.updated?.includes(GUIDE_IMPORT_FILE))
    parts.push("`CLAUDE.md` got `@AGENTS.md` as its first line; the rest of it is as it was.");
  if (removed.includes(STATUS_DOC))
    parts.push(
      "`docs/status.md` was Forerunner's untouched template, so it is taken out: the status is kept in Forerunner, not in the repository.",
    );
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

/** Whether `dir` holds the guide these facts give: Forerunner's part as rendered, and the import. */
export function guideIsCurrentIn(dir: string, facts: GuideFacts): boolean {
  let agents: string;
  let claude: string;
  try {
    agents = readFileSync(join(dir, GUIDE_FILE), "utf8");
    claude = readFileSync(join(dir, GUIDE_IMPORT_FILE), "utf8");
  } catch {
    return false;
  }
  return (
    guidePartOf(agents) === renderGuidePart(facts) &&
    claude.split(/\r?\n/).some((l) => l.trim() === GUIDE_IMPORT_LINE)
  );
}
