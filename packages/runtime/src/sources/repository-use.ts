import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import nodePath from "node:path"; // path-ok: path.win32 compares a Windows path on any platform (the platform module has no win32 form)
import {
  type GitHost,
  type PullRequestInfo,
  type RepoRef,
  readForerunnerMarker,
} from "@forerunner/capabilities";
import {
  type Clock,
  currentPlatform,
  ForerunnerError,
  type Platform,
  safeSegment,
} from "@forerunner/platform";
import type { ProjectRow, StateStore } from "@forerunner/state";
import { scanForInjection } from "../injection/scan.ts";
import { DEFAULT_REPO_HOSTS, parseRepoLocator, type RepoLocator, repoKey } from "./locators.ts";
import { INSTALL_MARKER_FILE, parseInstallMarker } from "./marker.ts";
import {
  ACTIVE_ELSEWHERE_DAYS,
  alreadyHereSentence,
  alsoElsewhereSentence,
  CHAT_TOGETHER_HINT,
  type Elsewhere,
  elsewhereSentence,
  inUseSentence,
  isLinkRefusalCause,
  isRemovedProject,
  isTogether,
  type LinkRefusalDetails,
  nothingToTakeOverSentence,
  otherHostSentence,
  projectIdsOf,
  scaffoldLeftNoMarker,
  TAKE_OVER_UNDO_MERGED,
  TAKE_OVER_UNDO_OPEN,
  TAKE_OVER_UNDO_UNREADABLE,
  TAKE_OVER_UNREADABLE,
  TOGETHER_OVERVIEW_DETAILS,
  TOGETHER_OVERVIEW_LINE,
  TOGETHER_UNREADABLE,
  type TookOverFacts,
  takeOverActiveSentence,
  takeOverDetails,
  takeOverLine,
  togetherFolderSentence,
  togetherLine,
  tookOverNoPullRequestSentence,
  tookOverOf,
} from "./repository-words.ts";

export * from "./repository-words.ts";

/**
 * One repository, one project (D1, ADR 0117; the owner's words of 2026-11-09: "There should not
 * be 2 projects in one repo. ... Make it such that multiple projects are not done on one repo, in
 * an intelligent way."). Every way of linking a repository or folder (New project, chat, Sources,
 * the Data tab's import) asks this module which project already uses it, by one identity of the
 * link (`identityOf`: every spelling of a GitHub repository, a folder by its real path with its
 * git root, worktree and origin read from files, never by a git process), and, for a repository,
 * which Forerunner project the repository itself names (`readRepository`: its install marker on
 * the default branch and the marks of its pull requests, with their activity). A project that is
 * not on this computer (another person's Forerunner, D9, or the person's own earlier install) is
 * offered to work on together (the same project id, nothing written to GitHub then) and, second,
 * to take over only while no other GitHub account worked on it within `ACTIVE_ELSEWHERE_DAYS`.
 */

/** Bound on the projects the index reads (as discovery's duplicate check); above it, words. */
export const MAX_PROJECTS = 10_000;

/** A project id as a marker names it (schema 1): a UUID. */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------
// The identity of a link
// ---------------------------------------------------------------------------------------------

/** What a link (one `repos` entry) is, as every entry point compares it. */
export interface LinkIdentity {
  entry: string;
  kind: "repo" | "folder";
  /** A repository's owner and name (a folder: its origin's, when it has one). */
  repo: RepoLocator | null;
  /** A folder's path as the platform compares it (real path; lower case on Windows). */
  folder: string | null;
  /** A folder's nearest enclosing git root (the folder holding `.git`), compared form. */
  gitRoot: string | null;
  /** A git worktree's main working tree (from its `.git` file and `commondir`), compared form. */
  mainRoot: string | null;
  /** Every key the link covers: `github:o/n` and `folder:<path>`. */
  keys: string[];
}

/** What reading a link gave: its identity, a host this install does not use, or nothing. */
export type IdentityResult =
  | { kind: "identity"; identity: LinkIdentity }
  | { kind: "other_host"; host: string; entry: string }
  | { kind: "none"; entry: string };

/** The files a folder's identity reads (tests may inject one; the default is node:fs). */
export interface IdentityFs {
  isDirectory(path: string): boolean;
  isFile(path: string): boolean;
  readText(path: string): string | null;
  realPath(path: string): string | null;
}

const nodeFs: IdentityFs = {
  isDirectory(p) {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  isFile(p) {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readText(p) {
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    } catch {
      return null;
    }
  },
  realPath(p) {
    try {
      return realpathSync.native(p);
    } catch {
      return null;
    }
  },
};

export interface IdentityOptions {
  /** The git hosts a URL may name (`repoHostsFor`); default github.com. */
  hosts?: readonly string[] | "any";
  /** The platform whose path rules apply; default this computer's. */
  platform?: Platform;
  fs?: IdentityFs;
}

function pathApi(platform: Platform): typeof nodePath.posix {
  return platform === "windows" ? nodePath.win32 : nodePath.posix;
}

/** The compared form of an absolute path: resolved, no trailing separator, Windows lower case. */
function comparedPath(p: string, platform: Platform): string {
  const api = pathApi(platform);
  const resolved = api.resolve(p);
  return platform === "windows" ? resolved.toLowerCase() : resolved;
}

/** Whether `inner` is strictly inside `outer` (both compared forms). */
function strictlyInside(inner: string, outer: string, platform: Platform): boolean {
  const rel = pathApi(platform).relative(outer, inner);
  return rel !== "" && !rel.startsWith("..") && !pathApi(platform).isAbsolute(rel);
}

/** The origin remote's URL in a git config file's text, or null. */
export function originUrlOf(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (section) {
      inOrigin = section[1]?.toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (kv?.[1]) return kv[1].trim().replace(/^"|"$/g, "");
  }
  return null;
}

interface GitFacts {
  gitRoot: string | null;
  mainRoot: string | null;
  originUrl: string | null;
}

/**
 * A folder's git facts read as files (no git process in the person's folder): the nearest
 * folder at or above it with a `.git` (folder, or a worktree's `.git` file whose `gitdir:` and
 * `commondir` lead to the main repository), and the origin remote in the common `config`.
 */
function gitFactsOf(folder: string, platform: Platform, fs: IdentityFs): GitFacts {
  const api = pathApi(platform);
  let dir = api.resolve(folder);
  for (;;) {
    const dotGit = api.join(dir, ".git");
    if (fs.isDirectory(dotGit)) {
      const config = fs.readText(api.join(dotGit, "config"));
      return { gitRoot: dir, mainRoot: null, originUrl: config ? originUrlOf(config) : null };
    }
    if (fs.isFile(dotGit)) {
      const text = fs.readText(dotGit) ?? "";
      const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
      if (gitdir) {
        const gitDir = api.resolve(dir, gitdir);
        const common = fs.readText(api.join(gitDir, "commondir"))?.trim();
        const commonDir = common ? api.resolve(gitDir, common) : gitDir;
        const config = fs.readText(api.join(commonDir, "config"));
        const mainRoot = api.basename(commonDir) === ".git" ? api.dirname(commonDir) : null;
        return { gitRoot: dir, mainRoot, originUrl: config ? originUrlOf(config) : null };
      }
      return { gitRoot: dir, mainRoot: null, originUrl: null };
    }
    const up = api.dirname(dir);
    if (up === dir) return { gitRoot: null, mainRoot: null, originUrl: null };
    dir = up;
  }
}

/**
 * The identity of one link: a GitHub repository in any spelling (`o/n`, `o/n.git`,
 * `github.com/o/n`, an HTTPS or SSH URL) on one of the install's hosts, or an absolute folder
 * by its real path, its git root, a worktree's main tree and its origin. A URL on another git
 * host is `other_host` (refused at link: OR-11); anything else is `none` (not compared).
 */
export function identityOf(entry: string, opts: IdentityOptions = {}): IdentityResult {
  const platform = opts.platform ?? currentPlatform();
  const fs = opts.fs ?? nodeFs;
  const hosts = opts.hosts ?? DEFAULT_REPO_HOSTS;
  const text = entry.trim();
  if (!text) return { kind: "none", entry };
  const api = pathApi(platform);
  if (api.isAbsolute(text)) {
    // The folder's files are read on this computer's own platform (or through a given reader).
    const readable = opts.fs !== undefined || platform === currentPlatform();
    const real = readable ? (fs.realPath(api.resolve(text)) ?? api.resolve(text)) : text;
    const folder = comparedPath(real, platform);
    const facts = readable
      ? gitFactsOf(real, platform, fs)
      : { gitRoot: null, mainRoot: null, originUrl: null };
    const origin = facts.originUrl ? parseRepoLocator(facts.originUrl, hosts) : null;
    const gitRoot = facts.gitRoot ? comparedPath(facts.gitRoot, platform) : null;
    const mainRoot = facts.mainRoot ? comparedPath(facts.mainRoot, platform) : null;
    const keys = [`folder:${folder}`];
    if (mainRoot) keys.push(`folder:${mainRoot}`);
    if (origin) keys.push(origin.key);
    return {
      kind: "identity",
      identity: { entry, kind: "folder", repo: origin, folder, gitRoot, mainRoot, keys },
    };
  }
  const any = parseRepoLocator(text, "any");
  if (!any) return { kind: "none", entry };
  const repo = hosts === "any" ? any : parseRepoLocator(text, hosts);
  if (!repo) return { kind: "other_host", host: any.host ?? "another host", entry };
  return {
    kind: "identity",
    identity: {
      entry,
      kind: "repo",
      repo,
      folder: null,
      gitRoot: null,
      mainRoot: null,
      keys: [repo.key],
    },
  };
}

/**
 * Whether two links name the same thing: one repository key (a folder's origin counts as its
 * repository), the same folder, a worktree and its main tree, or a folder inside a linked one
 * that has no git root of its own below the linked one (validation rule 5: with `C:\Code`
 * linked, `C:\Code\notes` is that project's but `C:\Code\shop` with its own `.git` is its own).
 */
export function sameLink(a: LinkIdentity, b: LinkIdentity, platform?: Platform): boolean {
  const p = platform ?? currentPlatform();
  if (a.keys.some((k) => b.keys.includes(k))) return true;
  const inside = (inner: LinkIdentity, outer: LinkIdentity) =>
    !!inner.folder &&
    !!outer.folder &&
    outer.kind === "folder" &&
    strictlyInside(inner.folder, outer.folder, p) &&
    !(inner.gitRoot && strictlyInside(inner.gitRoot, outer.folder, p));
  return inside(a, b) || inside(b, a);
}

// ---------------------------------------------------------------------------------------------
// Projects on this computer
// ---------------------------------------------------------------------------------------------

/** A project on this computer that uses a link, with the link it uses (for the words). */
export interface ProjectUse {
  project: ProjectRow;
  /** The entry of the project that matched. */
  entry: string;
  identity: LinkIdentity;
}

/**
 * The index of what this computer's projects use (one per call: every check reads the store
 * again, so a project made or removed a moment ago counts). Every project row that is not
 * archived counts; archived rows tell a joined project (its keeper counts as it) and a removed
 * one (it uses nothing) apart. Bounded like discovery: above `MAX_PROJECTS` it refuses in words.
 */
export class RepositoryIndex {
  private constructor(
    readonly rows: readonly ProjectRow[],
    private readonly opts: IdentityOptions,
  ) {}

  static async read(
    store: Pick<StateStore, "project">,
    opts: IdentityOptions = {},
  ): Promise<RepositoryIndex> {
    const rows = await store.project.list(undefined, {
      orderBy: [{ column: "created_at" }, { column: "id" }],
      limit: MAX_PROJECTS + 1,
    });
    if (rows.length > MAX_PROJECTS)
      throw new ForerunnerError(
        "validation",
        `This computer has more than ${MAX_PROJECTS.toLocaleString("en-US")} projects, so the link cannot be checked. Archive some first.`,
        { details: { cause: "too_many_projects", max: MAX_PROJECTS } },
      );
    return new RepositoryIndex(rows, opts);
  }

  private readonly identities = new Map<string, LinkIdentity | null>();

  private identity(entry: string): LinkIdentity | null {
    if (!this.identities.has(entry)) {
      const r = identityOf(entry, this.opts);
      this.identities.set(entry, r.kind === "identity" ? r.identity : null);
    }
    return this.identities.get(entry) ?? null;
  }

  /** The project a joined one counts as (d1109-onerepo-join's `joined_from` on the keeper). */
  keeperOf(projectId: string): ProjectRow | null {
    for (const p of this.rows) {
      if (p.status === "archived") continue;
      if (p.id !== projectId && projectIdsOf(p).includes(projectId)) return p;
    }
    return null;
  }

  /** The row of an id on this install, any status. */
  row(id: string): ProjectRow | null {
    return this.rows.find((p) => p.id === id) ?? null;
  }

  /**
   * Whether `id` names a project of this install: a row, joined into one, or taken over here.
   * L4-github-101 (ADR 0117 point 2): a removed project uses nothing, so neither its take-over
   * nor the ids joined into it make an id known (live check 4: after the Undo of a project made
   * with Take it over, New project on that repository got no offer and took nothing over, while
   * the repository still named "Kite club"). A project joined into another still counts through
   * its keeper, which is not removed. The removed project's own id stays a row here: the marker
   * that names it frees the repository (`verdictOf`'s `removed`, run C decision 14).
   */
  knows(id: string): boolean {
    if (this.row(id)) return true;
    for (const p of this.rows) {
      if (isRemovedProject(p)) continue;
      if (projectIdsOf(p).includes(id)) return true;
      if (tookOverOf(p)?.projects.includes(id)) return true;
    }
    return false;
  }

  /**
   * The projects here using the link (a joined project counted as its keeper; a removed one
   * uses nothing), each once, oldest first; `except` leaves one project out (the asking one).
   */
  projectsUsing(link: LinkIdentity, except?: string): ProjectUse[] {
    const platform = this.opts.platform ?? currentPlatform();
    const out: ProjectUse[] = [];
    for (const p of this.rows) {
      if (p.status === "archived") continue;
      if (except && p.id === except) continue;
      for (const entry of p.repos ?? []) {
        if (typeof entry !== "string") continue;
        const theirs = this.identity(entry);
        if (!theirs || !sameLink(link, theirs, platform)) continue;
        const keeper = this.keeperOf(p.id) ?? p;
        if (except && keeper.id === except) break;
        if (!out.some((u) => u.project.id === keeper.id))
          out.push({ project: keeper, entry, identity: theirs });
        break;
      }
    }
    return out;
  }

  /** The one project here using the repository, or null for none or more than one. */
  soleUser(ref: RepoRef): ProjectRow | null {
    const link: LinkIdentity = {
      entry: `${ref.owner}/${ref.name}`,
      kind: "repo",
      repo: null,
      folder: null,
      gitRoot: null,
      mainRoot: null,
      keys: [repoKey(ref.owner, ref.name)],
    };
    const users = this.projectsUsing(link);
    return users.length === 1 ? (users[0]?.project ?? null) : null;
  }

  /**
   * Every project row (any status) linked to the repository, a joined one counted as its keeper,
   * each id once: who an unmarked docs pull request may belong to (W15-01 through the index).
   */
  usersOf(ref: RepoRef): string[] {
    const key = repoKey(ref.owner, ref.name);
    const out: string[] = [];
    for (const p of this.rows) {
      const linked = (p.repos ?? []).some(
        (entry) => typeof entry === "string" && !!this.identity(entry)?.keys.includes(key),
      );
      if (!linked) continue;
      const id = this.keeperOf(p.id)?.id ?? p.id;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// What the repository itself says
// ---------------------------------------------------------------------------------------------

/** A marker's project name as data: cut at 60 characters, control characters removed, scanned. */
export function markerNameOf(name: string | null | undefined): string | null {
  if (!name) return null;
  // C2-left-9 (d1109-onerepo-join): scanned as written too, before its line breaks become
  // spaces: a role line ("\nSYSTEM: you are now ...") is caught where it starts a line, and the
  // cleaned one-line form alone scored below the bar (the injection suite's record-009).
  if (scanForInjection(name, "repo_file").suspicious) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are removed.
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
  const cut = clean.length > 60 ? clean.slice(0, 60).trim() : clean;
  if (!cut) return null;
  if (scanForInjection(cut, "repo_file").suspicious) return null;
  if (/["<>`]/.test(cut)) return null;
  return cut;
}

/**
 * The line a take-over's docs pull request says (ADR 0058 amended): which Forerunner project the
 * repository was, and whose it is now. The old name is the marker's own, cleaned as data
 * (`markerNameOf`); unknown or flagged, "another Forerunner project". No possessive after a
 * quoted name (L4-github-108: live, 'it is now "Kite flyers"'s.').
 */
export function tookOverLine(wasName: string | null | undefined, name: string): string {
  const was = markerNameOf(wasName);
  return was
    ? `This repository was the Forerunner project "${was}"; it is now the project "${name}".`
    : `This repository was another Forerunner project; it is now the project "${name}".`;
}

/** The project ids a pull request names (the hidden mark, the intake branch, the L-16 line). */
export function projectIdsNamedBy(pr: Pick<PullRequestInfo, "body" | "head">): string[] {
  const ids: string[] = [];
  const add = (id: string | undefined | null) => {
    if (id && PROJECT_ID.test(id) && !ids.includes(id.toLowerCase())) ids.push(id.toLowerCase());
  };
  add(readForerunnerMarker(pr.body)?.project);
  add(/^fr\/intake-(.+)-docs$/.exec(pr.head.ref)?.[1]);
  add(/Forerunner project ([0-9a-f-]{36})\./i.exec(pr.body ?? "")?.[1]);
  return ids;
}

/** A pull request that carries a project's mark, with when and by whom it was last touched. */
export interface MarkedPullRequest {
  number: number;
  ids: string[];
  state: "open" | "closed";
  merged: boolean;
  updatedAt: string | null;
  authorLogin: string | null;
}

/** What one read of a repository gave: its marker and its marked pull requests. */
export interface RepositoryRead {
  /** The marker on the default branch (schema 1, its project a UUID), or null. */
  marker: { project: string; name: string | null } | null;
  /** A file is there but is no marker this schema wrote. */
  markerUnreadable: boolean;
  /** Pull requests carrying a project mark (state 'all', most recently updated first, 100). */
  marked: MarkedPullRequest[];
  /** This install's GitHub login, or null when the host did not say. */
  login: string | null;
}

/**
 * Reads what the repository says about Forerunner: its install marker on the default branch
 * and the marks of its pull requests in any state, most recently updated first (one page of
 * 100). Repository text is parsed strictly and is data: a marker's name is cut, cleaned and
 * scanned before it is ever shown (`markerNameOf`). Throws what the host throws.
 */
export async function readRepository(host: GitHost, ref: RepoRef): Promise<RepositoryRead> {
  let marker: RepositoryRead["marker"] = null;
  let markerUnreadable = false;
  const file = await host.getFile(ref, INSTALL_MARKER_FILE).catch((e: unknown) => {
    if (e instanceof ForerunnerError && e.code === "not_found") return null;
    throw e;
  });
  if (file) {
    const parsed = parseInstallMarker(file.content);
    if (parsed && PROJECT_ID.test(parsed.project))
      marker = { project: parsed.project.toLowerCase(), name: markerNameOf(parsed.name) };
    else markerUnreadable = true;
  }
  const prs = await host.listPullRequests(ref, { state: "all", sort: "updated" });
  const marked: MarkedPullRequest[] = [];
  for (const pr of prs.slice(0, 100)) {
    const ids = projectIdsNamedBy(pr);
    if (!ids.length) continue;
    marked.push({
      number: pr.number,
      ids,
      state: pr.state,
      merged: pr.merged,
      updatedAt: pr.updatedAt ?? null,
      authorLogin: pr.authorLogin ?? null,
    });
  }
  let login: string | null = null;
  try {
    login = (await host.whoAmI()).login || null;
  } catch {
    login = null;
  }
  return { marker, markerUnreadable, marked, login };
}

/** What the repository means for a new link on this computer. */
export type RepositoryVerdict =
  | { kind: "free" }
  | { kind: "here"; project: ProjectRow }
  | { kind: "removed"; projectId: string }
  | { kind: "removed_together"; project: ProjectRow; elsewhere: Elsewhere }
  | { kind: "elsewhere"; elsewhere: Elsewhere };

/**
 * The repository's project as this install sees it. The marker decides when there is one; with
 * none, the ids the open pull requests' marks carry. An id that is a row here (not archived) is
 * that project's (`here`); a project removed here that was never together frees the repository
 * (`removed`, the creation records it as taken over); a removed together project is the other
 * Forerunner's too (`removed_together`, Work together brings that row back); an id joined into a
 * project here counts as its keeper; any other id is a project that is not on this computer.
 */
export function verdictOf(
  read: RepositoryRead,
  index: RepositoryIndex,
  nowMs: number,
): RepositoryVerdict {
  const markerId = read.marker?.project ?? null;
  const openIds = [...new Set(read.marked.filter((p) => p.state === "open").flatMap((p) => p.ids))];
  const named = markerId ? [markerId] : openIds;
  if (!named.length) return { kind: "free" };
  const unknown: string[] = [];
  for (const id of named) {
    const row = index.row(id);
    if (row && row.status !== "archived") return { kind: "here", project: row };
    const keeper = index.keeperOf(id);
    if (keeper) return { kind: "here", project: keeper };
    if (row && isRemovedProject(row)) {
      if (isTogether(row))
        return {
          kind: "removed_together",
          project: row,
          elsewhere: elsewhereOf(read, [id], nowMs),
        };
      if (named.length === 1) return { kind: "removed", projectId: id };
      continue;
    }
    if (row) continue;
    if (index.knows(id)) continue;
    unknown.push(id);
  }
  if (!unknown.length) return { kind: "free" };
  return { kind: "elsewhere", elsewhere: elsewhereOf(read, unknown, nowMs) };
}

function elsewhereOf(read: RepositoryRead, ids: string[], nowMs: number): Elsewhere {
  const mine = (login: string | null) =>
    !!login && !!read.login && login.toLowerCase() === read.login.toLowerCase();
  const ofThem = read.marked.filter((p) => p.ids.some((id) => ids.includes(id)));
  const dated = ofThem
    .filter((p): p is MarkedPullRequest & { updatedAt: string } => !!p.updatedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latest = dated[0];
  const since = nowMs - ACTIVE_ELSEWHERE_DAYS * 24 * 3600_000;
  // C2-left-10 (d1109-onerepo-join): a pull request whose author GitHub does not name (a deleted
  // account, an app) counts as another account's: unknown is never "nobody", so no take-over is
  // offered on it within the 14 days (the safe side).
  const other = dated.find((p) => !mine(p.authorLogin) && Date.parse(p.updatedAt) >= since);
  const one = ids.length === 1;
  return {
    ids,
    name: one && read.marker?.project === ids[0] ? (read.marker?.name ?? null) : null,
    lastActive: latest ? { at: latest.updatedAt, own: mine(latest.authorLogin) } : null,
    otherAccount: other ? other.updatedAt : null,
    canWorkTogether: one,
    canTakeOver: !other,
  };
}

// ---------------------------------------------------------------------------------------------
// The words (design section 5)
// ---------------------------------------------------------------------------------------------

/**
 * How a link reads in a sentence: a repository as `o/site`, spelled as the project that uses
 * it has it when it is given (`theirs`); a folder as its path.
 */
export function linkWords(identity: LinkIdentity, theirs?: LinkIdentity | null): string {
  if (identity.kind === "repo" && identity.repo)
    return theirs?.kind === "repo" && theirs.repo ? theirs.repo.locator : identity.repo.locator;
  return identity.entry.trim();
}

/** The safe segment of an id as an intake branch carries it (for the take-over's checks). */
export function intakeBranchOf(id: string): string {
  return `fr/intake-${safeSegment(id, "project")}-docs`;
}

/** Whether `clock`-relative instants are within the activity window. */
export function withinActiveWindow(iso: string, clock: Pick<Clock, "now">): boolean {
  return Date.parse(iso) >= clock.now() - ACTIVE_ELSEWHERE_DAYS * 24 * 3600_000;
}

// ---------------------------------------------------------------------------------------------
// The check every entry point runs before anything is written
// ---------------------------------------------------------------------------------------------

/** The refusal of a link, before anything is written. */
export function linkRefusal(message: string, details: LinkRefusalDetails): ForerunnerError {
  return new ForerunnerError("validation", message, { details: { ...details } });
}

/** Whether an error is a link's refusal. */
export function isLinkRefusal(e: unknown): e is ForerunnerError & {
  details: LinkRefusalDetails;
} {
  return e instanceof ForerunnerError && isLinkRefusalCause(e.details?.cause);
}

/**
 * `project.create`'s check from chat, voice or the palette: the same check, its refusal's
 * sentence the tool's answer (with the together hint where Work together is offered) and its
 * details kept (the untrusted mark among them: the sentence may quote a marker's name).
 */
export async function chatLinkCheck(
  use: Pick<RepositoryUse, "check">,
  repos: readonly string[],
): Promise<void> {
  try {
    await use.check(repos);
  } catch (e) {
    if (
      isLinkRefusal(e) &&
      e.details.cause === "repository_used_elsewhere" &&
      e.details.canWorkTogether
    )
      throw new ForerunnerError("validation", `${e.message} ${CHAT_TOGETHER_HINT}`, {
        details: { ...e.details },
      });
    throw e;
  }
}

/** What a creation may go on with once the link is checked. */
export interface LinkCheck {
  /** The take-over the creation records (`settings.took_over`). */
  tookOver?: TookOverFacts;
  /** Work together (D9): the repository's project id and what the offer said. */
  together?: { id: string; name: string | null; activeOn: string | null; login: string | null };
  /** Work together on a removed together project: that row comes back. */
  revive?: ProjectRow;
  /** The repository the check read (null for a folder or none). */
  repository?: RepoRef | null;
}

export interface LinkCheckOptions {
  takeOver?: { projects: string[] } | undefined;
  together?: { project: string } | undefined;
  /** The creation carries a brief or a goal (Work together's line then says it plans it). */
  withBrief?: boolean;
  /** Leave this project out (a project's own link, e.g. the Data tab's import into it). */
  except?: string;
}

export interface RepositoryUseDeps {
  store: Pick<StateStore, "project">;
  clock: Pick<Clock, "now" | "nowIso">;
  /** The configured git host when GitHub can be read (a token is saved); null otherwise. */
  host: () => Promise<GitHost | null>;
  /** The git hosts a URL may name (`repoHostsFor`). */
  hosts?: readonly string[];
  /** The person's time zone, for the offer's dates. */
  timezone?: () => Promise<string | null>;
  identity?: Omit<IdentityOptions, "hosts">;
  /**
   * OR-07: this computer's copy of a project's repository, its marker file's text (the default
   * branch, read as a file: `ProjectDocs.copyMarker`); null without one.
   */
  copyMarker?: (projectId: string) => string | null;
  /**
   * C2-left-10: how long a check waits on GitHub before it counts the read as failed (a GitHub
   * that hangs rather than refuses follows the same rule as an error: creation goes on without
   * it, Work together and Take it over are refused in words). Default `READ_WAIT_MS`.
   */
  readWaitMs?: number;
}

/** How long a check waits on GitHub's answer before it counts as no answer (C2-left-10). */
export const READ_WAIT_MS = 8_000;

/** `work` when it answers within `ms`, else a rejection: a read that never answers is a failed one. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ForerunnerError("unavailable", "GitHub did not answer in time")),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * OR-07: the Overview's line about the project's repository (`ProjectCard.repositoryElsewhere`):
 * `elsewhere` when this computer's copy names a Forerunner project that is not on this computer
 * (with Take it over unless another GitHub account worked on it within 14 days), `together` for
 * a project worked on together with another Forerunner (D9).
 */
export interface RepositoryOverview {
  kind: "elsewhere" | "together";
  text: string;
  canTakeOver: boolean;
  /** Take it over's consequence line; null without the button. */
  takeOverLine: string | null;
  /** The line's Details. */
  details: string | null;
}

/** How long the Overview reuses a read of a repository's marks (the press always reads anew). */
const OVERVIEW_READ_MS = 5 * 60_000;
/** The Overview never waits longer than this on GitHub: the line shows, the press checks. */
const OVERVIEW_WAIT_MS = 4_000;

/**
 * Forerunner's docs branches: the scaffold's (`fr/docs-scaffold`, or the project's own
 * `fr/docs-scaffold-<project>` when that one is another's, L4-github-102) and an intake's doc
 * set (`loop/docs.ts`).
 */
const DOCS_BRANCH = /^fr\/(?:docs-scaffold(?:-[\w-]+)?|intake-[^/]+-docs)$/;

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a.map((s) => s.toLowerCase()))].sort();
  const y = [...new Set(b.map((s) => s.toLowerCase()))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * The one check of a link (ADR 0117), run before anything is written by every creation
 * (`createProjectRecord`: POST /projects, Sources' accept, the chat's port), by `project.create`'s
 * plan and run (the commands' `repositoryUse` port), and by the Data tab's import. A refusal is a
 * `ForerunnerError` 'validation' (HTTP 409) whose details say the offer (`LinkRefusalDetails`).
 * GitHub that cannot be read skips the repository's own check without a word (creation fails
 * open there, the one place: ADR 0117); Work together needs GitHub's answer and is refused.
 */
export class RepositoryUse {
  constructor(private readonly deps: RepositoryUseDeps) {}

  /** One read of the repository, never waited on longer than the check's wait (C2-left-10). */
  private readRepo(host: GitHost, ref: RepoRef): Promise<RepositoryRead> {
    return within(readRepository(host, ref), this.deps.readWaitMs ?? READ_WAIT_MS);
  }

  /** The Overview's reads of a repository's marks, by repository key (`OVERVIEW_READ_MS`). */
  private readonly reads = new Map<string, { at: number; read: RepositoryRead | null }>();

  private identityOptions(): IdentityOptions {
    return { ...(this.deps.identity ?? {}), hosts: this.deps.hosts ?? DEFAULT_REPO_HOSTS };
  }

  /** The index over this computer's projects, read now. */
  async index(): Promise<RepositoryIndex> {
    return RepositoryIndex.read(this.deps.store, this.identityOptions());
  }

  /** The identities of the links (a URL on another host refused in words). */
  identities(repos: readonly string[]): LinkIdentity[] {
    const out: LinkIdentity[] = [];
    for (const entry of repos) {
      if (typeof entry !== "string") continue;
      const r = identityOf(entry, this.identityOptions());
      if (r.kind === "other_host")
        throw linkRefusal(otherHostSentence(r.host), { cause: "other_host" });
      if (r.kind === "identity") out.push(r.identity);
    }
    return out;
  }

  /** The configured host, or null when GitHub cannot be read here (no token). */
  async host(): Promise<GitHost | null> {
    return this.deps.host().catch(() => null);
  }

  private async zone(): Promise<string | null> {
    try {
      return (await this.deps.timezone?.()) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The check on this computer only (a URL on another host, a project here that uses the link),
   * for a link added to a project that exists (the Data tab's import, OR-04): `except` is that
   * project, whose own link it may be.
   */
  async checkHere(repos: readonly string[], except?: string): Promise<void> {
    const links = this.identities(repos);
    if (!links.length) return;
    const index = await this.index();
    for (const link of links) {
      const use = index.projectsUsing(link, except)[0];
      if (use)
        throw linkRefusal(
          inUseSentence(
            { kind: link.kind, locator: linkWords(link, use.identity) },
            use.project.name,
          ),
          { cause: "repository_in_use", projectId: use.project.id, projectName: use.project.name },
        );
    }
  }

  async check(repos: readonly string[], opts: LinkCheckOptions = {}): Promise<LinkCheck> {
    const links = this.identities(repos);
    if (!links.length) {
      if (opts.together)
        throw linkRefusal(togetherFolderSentence(null), { cause: "together_refused" });
      return {};
    }
    const index = await this.index();
    // On this computer first: a project here that uses the link is the offer, whatever GitHub says.
    for (const link of links) {
      const use = index.projectsUsing(link, opts.except)[0];
      if (use) {
        const locator = linkWords(link, use.identity);
        throw linkRefusal(inUseSentence({ kind: link.kind, locator }, use.project.name), {
          cause: "repository_in_use",
          projectId: use.project.id,
          projectName: use.project.name,
        });
      }
    }
    const repoLink = links.find((l) => l.kind === "repo" && l.repo);
    if (!repoLink?.repo) {
      if (opts.together) {
        const origin = links.find((l) => l.repo)?.repo?.locator ?? null;
        throw linkRefusal(togetherFolderSentence(origin), { cause: "together_refused" });
      }
      return {};
    }
    // GitHub reads owner and name in any case; the key's lower case is the one spelling read.
    const ref: RepoRef = {
      owner: repoLink.repo.owner.toLowerCase(),
      name: repoLink.repo.name.toLowerCase(),
    };
    const locator = repoLink.repo.locator;
    const host = await this.host();
    let read: RepositoryRead | null = null;
    if (host) {
      try {
        read = await this.readRepo(host, ref);
      } catch {
        read = null;
      }
    }
    if (!read) {
      // The one fail-open place (ADR 0117): creation never waits on GitHub's answer; the
      // Overview's line appears once the copy shows another project's marker. Work together
      // needs the id from GitHub, so it is refused instead.
      if (opts.together) throw linkRefusal(TOGETHER_UNREADABLE, { cause: "github_unreadable" });
      return { repository: ref };
    }
    const verdict = verdictOf(read, index, this.deps.clock.now());
    const at = this.deps.clock.nowIso();
    switch (verdict.kind) {
      case "free":
        if (opts.together)
          throw linkRefusal(
            `${locator} names no Forerunner project now: create it as a new project.`,
            { cause: "together_refused" },
          );
        return { repository: ref };
      case "here":
        if (opts.except && verdict.project.id === opts.except) return { repository: ref };
        throw linkRefusal(
          opts.together
            ? alreadyHereSentence(locator, verdict.project.name)
            : inUseSentence({ kind: "repo", locator }, verdict.project.name),
          {
            cause: "repository_in_use",
            projectId: verdict.project.id,
            projectName: verdict.project.name,
          },
        );
      case "removed":
        // The person's own removed project frees the repository: its marker is replaced.
        return {
          repository: ref,
          tookOver: { projects: [verdict.projectId], name: "", at, removed: true },
        };
      case "removed_together": {
        if (opts.together && opts.together.project.toLowerCase() === verdict.project.id)
          return { repository: ref, revive: verdict.project };
        throw await this.elsewhereRefusal(locator, verdict.elsewhere, opts);
      }
      case "elsewhere": {
        const e = verdict.elsewhere;
        if (opts.together) {
          const id = e.ids[0];
          if (e.canWorkTogether && id && opts.together.project.toLowerCase() === id)
            return {
              repository: ref,
              together: {
                id,
                name: e.name,
                activeOn: e.lastActive?.at ?? null,
                login: read.login,
              },
            };
          throw await this.elsewhereRefusal(locator, e, opts);
        }
        if (opts.takeOver && e.canTakeOver && sameIds(opts.takeOver.projects, e.ids))
          return {
            repository: ref,
            tookOver: { projects: e.ids, name: e.name ?? "", at, removed: false },
          };
        throw await this.elsewhereRefusal(locator, e, opts);
      }
    }
  }

  /** The project's GitHub repository, as the index keys it; null for a folder or none. */
  private repositoryOf(
    project: Pick<ProjectRow, "repos">,
  ): { ref: RepoRef; locator: string; key: string } | null {
    let links: LinkIdentity[];
    try {
      links = this.identities(project.repos ?? []);
    } catch {
      return null;
    }
    const link = links.find((l) => l.kind === "repo" && l.repo);
    if (!link?.repo) return null;
    return {
      ref: { owner: link.repo.owner.toLowerCase(), name: link.repo.name.toLowerCase() },
      locator: link.repo.locator,
      key: link.keys[0] ?? link.repo.locator.toLowerCase(),
    };
  }

  /**
   * OR-07: the Overview's line about the project's repository, or null. The copy's marker is
   * read as a file (no git process, no GitHub call); only a marker naming a project that is not on
   * this computer reads the repository's pull request marks for the 14-day rule, reused for
   * `OVERVIEW_READ_MS` and never waited on longer than `OVERVIEW_WAIT_MS` (the press reads anew).
   */
  async overviewOf(project: ProjectRow): Promise<RepositoryOverview | null> {
    if (project.status === "archived") return null;
    if (isTogether(project))
      return {
        kind: "together",
        text: TOGETHER_OVERVIEW_LINE,
        canTakeOver: false,
        takeOverLine: null,
        details: TOGETHER_OVERVIEW_DETAILS,
      };
    const repo = this.repositoryOf(project);
    if (!repo) return null;
    const text = this.deps.copyMarker?.(project.id) ?? null;
    const parsed = text ? parseInstallMarker(text) : null;
    const id = parsed && PROJECT_ID.test(parsed.project) ? parsed.project.toLowerCase() : null;
    if (!id) return null;
    // L4-github-102: taken over here, but the default branch still names the other project and
    // the scaffold left no docs pull request that names this one: said, never "Took over" alone.
    const took = tookOverOf(project);
    if (
      took &&
      !took.removed &&
      took.projects.map((p) => p.toLowerCase()).includes(id) &&
      scaffoldLeftNoMarker(project)
    )
      return {
        kind: "elsewhere",
        text: tookOverNoPullRequestSentence(repo.locator, {
          ids: took.projects,
          name: markerNameOf(took.name) ?? markerNameOf(parsed?.name),
        }),
        canTakeOver: false,
        takeOverLine: null,
        details: null,
      };
    const own = new Set([...projectIdsOf(project), ...(tookOverOf(project)?.projects ?? [])]);
    if (own.has(id)) return null;
    const index = await this.index();
    // A project here (two on one repository made before the rule: d1109-onerepo-join's line),
    // or one joined into or taken over by a project here, is not "not on this computer".
    if (index.row(id) || index.knows(id)) return null;
    const name = markerNameOf(parsed?.name);
    const read = await this.overviewRead(repo.key, repo.ref);
    const e: Elsewhere = read
      ? { ...elsewhereOf(read, [id], this.deps.clock.now()), name }
      : {
          ids: [id],
          name,
          lastActive: null,
          otherAccount: null,
          canWorkTogether: true,
          canTakeOver: true,
        };
    return {
      kind: "elsewhere",
      text: alsoElsewhereSentence(repo.locator, e, await this.zone()),
      canTakeOver: e.canTakeOver,
      takeOverLine: e.canTakeOver ? takeOverLine(e) : null,
      details: e.canTakeOver ? takeOverDetails(e) : null,
    };
  }

  private async overviewRead(key: string, ref: RepoRef): Promise<RepositoryRead | null> {
    const now = this.deps.clock.now();
    const kept = this.reads.get(key);
    if (kept && now - kept.at < OVERVIEW_READ_MS) return kept.read;
    const host = await this.host();
    if (!host) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([
      readRepository(host, ref).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), OVERVIEW_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    this.reads.set(key, { at: now, read });
    return read;
  }

  /**
   * OR-07 (`repo.take_over`'s check, at the press and again at its run): the ids the repository
   * names that are not on this computer, read from GitHub now. Refused in words when GitHub does
   * not answer, when another GitHub account worked on it within 14 days, or when there is
   * nothing to take over.
   */
  async takeOverFacts(
    projectId: string,
  ): Promise<{ locator: string; projects: string[]; name: string | null }> {
    const project = await this.deps.store.project.mustGet(projectId);
    const repo = this.repositoryOf(project);
    if (!repo || isTogether(project))
      throw linkRefusal(nothingToTakeOverSentence(repo?.locator ?? "This project's repository"), {
        cause: "together_refused",
      });
    const host = await this.host();
    let read: RepositoryRead | null = null;
    if (host) read = await this.readRepo(host, repo.ref).catch(() => null);
    if (!read) throw linkRefusal(TAKE_OVER_UNREADABLE, { cause: "github_unreadable" });
    this.reads.set(repo.key, { at: this.deps.clock.now(), read });
    const index = await this.index();
    const verdict = verdictOf(read, index, this.deps.clock.now());
    const untrusted = { source: "repo_file", origin: `repository:${repo.locator}` } as const;
    switch (verdict.kind) {
      case "free":
        throw linkRefusal(nothingToTakeOverSentence(repo.locator), { cause: "together_refused" });
      case "here":
        if (verdict.project.id === project.id)
          throw linkRefusal(nothingToTakeOverSentence(repo.locator), {
            cause: "together_refused",
          });
        throw linkRefusal(alreadyHereSentence(repo.locator, verdict.project.name), {
          cause: "repository_in_use",
          projectId: verdict.project.id,
          projectName: verdict.project.name,
        });
      case "removed":
        return {
          locator: repo.locator,
          projects: [verdict.projectId],
          name: read.marker?.name ?? null,
        };
      case "removed_together":
      case "elsewhere": {
        const e = verdict.elsewhere;
        if (!e.canTakeOver)
          throw linkRefusal(takeOverActiveSentence(repo.locator, e, await this.zone()), {
            cause: "repository_used_elsewhere",
            projects: e.ids,
            canWorkTogether: e.canWorkTogether,
            canTakeOver: false,
            untrusted,
          });
        return { locator: repo.locator, projects: e.ids, name: e.name };
      }
    }
  }

  /**
   * OR-07 (`repo.take_over`'s Undo): refused once the take-over's docs pull request exists on
   * GitHub, open (close it there first) or merged (the repository names this project); and when
   * GitHub cannot be read, since an Undo that cannot see GitHub would promise what it cannot do.
   */
  async takeOverUndoBlocked(
    projectId: string,
    since: string,
    prUrl: string | null,
  ): Promise<string | null> {
    const project = await this.deps.store.project.mustGet(projectId);
    const repo = this.repositoryOf(project);
    if (!repo) return null;
    const host = await this.host();
    if (!host) return TAKE_OVER_UNDO_UNREADABLE;
    const wait = this.deps.readWaitMs ?? READ_WAIT_MS;
    try {
      const file = await within(host.getFile(repo.ref, INSTALL_MARKER_FILE), wait).catch(
        (e: unknown) => {
          if (e instanceof ForerunnerError && e.code === "not_found") return null;
          throw e;
        },
      );
      const named = file ? parseInstallMarker(file.content)?.project?.toLowerCase() : null;
      if (named && named === project.id.toLowerCase()) return TAKE_OVER_UNDO_MERGED;
      const prs = await within(
        host.listPullRequests(repo.ref, { state: "all", sort: "updated" }),
        wait,
      );
      const its = prs.filter(
        (pr) =>
          (!!prUrl && pr.htmlUrl === prUrl) ||
          (DOCS_BRANCH.test(pr.head.ref) &&
            projectIdsNamedBy(pr).includes(project.id.toLowerCase()) &&
            !!pr.updatedAt &&
            (!since || pr.updatedAt >= since)),
      );
      if (its.some((pr) => pr.merged)) return TAKE_OVER_UNDO_MERGED;
      if (its.some((pr) => pr.state === "open")) return TAKE_OVER_UNDO_OPEN;
      return null;
    } catch {
      return TAKE_OVER_UNDO_UNREADABLE;
    }
  }

  private async elsewhereRefusal(
    locator: string,
    e: Elsewhere,
    opts: LinkCheckOptions,
  ): Promise<ForerunnerError> {
    return linkRefusal(elsewhereSentence(locator, e, await this.zone()), {
      cause: "repository_used_elsewhere",
      projects: e.ids,
      ...(e.name ? { projectName: e.name } : {}),
      canWorkTogether: e.canWorkTogether,
      canTakeOver: e.canTakeOver,
      ...(e.canWorkTogether ? { togetherLine: togetherLine(e, opts.withBrief === true) } : {}),
      ...(e.canTakeOver
        ? { takeOverLine: takeOverLine(e), takeOverDetails: takeOverDetails(e) }
        : {}),
      untrusted: { source: "repo_file", origin: `repository:${locator}` },
    });
  }
}
