import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { GitOps } from "@forerunner/capabilities/githost/git";
import {
  basename,
  type Clock,
  dirname,
  extname,
  ForerunnerError,
  isAbsolute,
  isInside,
  join,
  log,
  newId,
  normalize,
  normalizeNewlines,
  relative,
  resolve,
  safeSegment,
  systemClock,
  toPosix,
} from "@forerunner/platform";
import type { AuditLogRepo, DataAssetRepo, ProjectRepo } from "@forerunner/state";
import { parseSecretRef, resolveSecretRefs, type Vault } from "@forerunner/vault";
import AdmZip from "adm-zip";
import type { DataAssets } from "./assets.ts";
import {
  type DataActor,
  type GitignoreGuardResult,
  type ImportedFile,
  type ImportResultView,
  type RepositoryImportView,
  truncatedWalkNote,
} from "./types.ts";
import { walkFolder } from "./walk.ts";

/**
 * ZIP, folder and GitHub repository import (spec A.3). A ZIP is extracted under the project
 * data dir with zip-slip, absolute-path and symlink entries refused or skipped and the entry
 * count and total size bounded; a folder is walked with the same limits and each file
 * registered where it sits (or copied when small and asked). Every file becomes a `data_asset`
 * row. When the project worktree is known, `.gitignore` gets the data dir so nothing large
 * reaches git. A GitHub repository is cloned under the project's repos dir and the migration
 * branch opened from the default branch, which the import never writes (ADR 0069).
 */
export interface ImportOptions {
  /** The project worktree; when set the gitignore guard runs. */
  worktreePath?: string;
  /** Folders: copy into the data dir instead of linking (ignored above the copy threshold). */
  copy?: boolean;
  /** Register each file as a data asset (default true). */
  register?: boolean;
  actor?: DataActor;
}

export interface DataImporterDeps {
  assets: DataAssets;
  store: { auditLog: AuditLogRepo; project: ProjectRepo; dataAsset: DataAssetRepo };
  clock?: Clock;
  /** Resolves `tokenRef` for a repository import; without it a reference is `not_supported`. */
  vault?: Vault;
  /** Where `owner/name` resolves to (`<base>/<owner>/<name>.git`). Default `https://github.com`. */
  gitRemoteBase?: string;
  /**
   * The install's token reference (`secret:<name>`) used when an import names none, the vault
   * holds it and the clone URL is on `gitRemoteBase`'s origin: the human's own GitHub token
   * from setup. Never a value.
   */
  defaultTokenRef?: string;
  /** Wall-clock limit per git command. Default 10 minutes (a clone can be large). */
  gitTimeoutMs?: number;
}

export interface GitHubImportInput {
  /**
   * `owner/name` (resolved against `gitRemoteBase`) or an http(s) clone URL. Credentials in
   * the URL are refused: the token comes by `tokenRef`.
   */
  repo: string;
  /** `secret:<name>` reference of the token; resolved from the vault, handed to git by env. */
  tokenRef?: string;
}

export interface RepositorySource {
  owner: string;
  name: string;
  slug: string;
  /** `scheme://host/path.git`, without userinfo, query or fragment. */
  url: string;
}

/** Branches the import opens are `forerunner/migration-<YYYY-MM-DD>` from the Clock. */
export const MIGRATION_BRANCH_PREFIX = "forerunner/migration-";
export const DEFAULT_GIT_REMOTE_BASE = "https://github.com";
const SLUG_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function migrationBranchName(clock: Clock): string {
  return `${MIGRATION_BRANCH_PREFIX}${clock.nowIso().slice(0, 10)}`;
}

function checkSlugSegment(segment: string, what: string): string {
  if (!SLUG_SEGMENT.test(segment) || segment === "." || segment === "..") {
    throw new ForerunnerError("validation", `repository ${what} is not a valid name: ${segment}`, {
      details: { [what]: segment },
    });
  }
  return segment;
}

/**
 * `owner/name` or an http(s) URL into owner, name, slug and a credential-free clone URL. A URL
 * with userinfo is refused outright (the token goes by reference), as is any non-http scheme
 * (ssh needs keys the runtime does not hold).
 */
export function parseRepositorySource(
  source: string,
  base: string = DEFAULT_GIT_REMOTE_BASE,
): RepositorySource {
  const raw = source.trim();
  if (!raw) throw new ForerunnerError("validation", "repository is required (owner/name or URL)");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !raw.includes("@")) {
    const parts = raw.replace(/\.git$/i, "").split("/");
    if (parts.length !== 2) {
      throw new ForerunnerError(
        "validation",
        `repository must be owner/name or an http(s) URL: ${raw}`,
        { details: { source: raw } },
      );
    }
    const owner = checkSlugSegment(parts[0] ?? "", "owner");
    const name = checkSlugSegment(parts[1] ?? "", "name");
    const root = base.replace(/\/+$/, "");
    return { owner, name, slug: `${owner}/${name}`, url: `${root}/${owner}/${name}.git` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ForerunnerError(
      "validation",
      `repository must be owner/name or an http(s) URL: ${raw}`,
      { details: { source: raw } },
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ForerunnerError(
      "validation",
      `repository URL must be http(s) (ssh and other schemes are not supported): ${url.protocol}`,
      { details: { protocol: url.protocol } },
    );
  }
  if (url.username || url.password) {
    throw new ForerunnerError(
      "validation",
      "credentials in a repository URL are never accepted; pass the token as a secret reference (tokenRef)",
    );
  }
  const segments = url.pathname
    .split("/")
    .filter((p) => p.length > 0)
    .map((p) => decodeURIComponent(p));
  if (segments.length < 2) {
    throw new ForerunnerError(
      "validation",
      `repository URL must end in owner/name: ${url.origin}${url.pathname}`,
      { details: { source: `${url.origin}${url.pathname}` } },
    );
  }
  const last = segments[segments.length - 1] ?? "";
  const name = checkSlugSegment(last.replace(/\.git$/i, ""), "name");
  const owner = checkSlugSegment(segments[segments.length - 2] ?? "", "owner");
  const prefix = segments.slice(0, -2).map((p) => encodeURIComponent(p));
  const path = [...prefix, encodeURIComponent(owner), `${encodeURIComponent(name)}.git`].join("/");
  return { owner, name, slug: `${owner}/${name}`, url: `${url.origin}/${path}` };
}

/** An http(s) URL without its userinfo; anything else (an scp form) with a `user@` prefix cut. */
export function withoutUserinfo(remote: string): string {
  try {
    const u = new URL(remote);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return remote.replace(/^[^@/]+@/, "");
  }
}

/**
 * True when two http(s) remote URLs name the same repository: same origin, same path up to a
 * trailing slash or `.git`. A URL that does not parse never matches.
 */
export function sameRepository(a: string, b: string): boolean {
  const key = (raw: string): string | null => {
    try {
      const u = new URL(raw);
      const path = u.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
      return `${u.origin}${path}`;
    } catch {
      return null;
    }
  };
  const ka = key(a);
  return ka !== null && ka === key(b);
}

/** The in-worktree folder convention for scratch data; always ignored by the guard. */
export const WORKTREE_DATA_DIR = ".forerunner-data";

export type ZipEntryCheck =
  | { ok: true; segments: string[] }
  | { ok: false; reject: string }
  | { ok: false; skip: string };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Validate one archive entry name. Rejections abort the whole import before anything is
 * written; skips leave the entry out and are listed in the result.
 */
export function checkZipEntryName(entryName: string, maxDepth: number): ZipEntryCheck {
  const raw = entryName.replace(/\\/g, "/");
  if (raw === "" || raw === "/") return { ok: false, skip: "empty name" };
  if (raw.includes("\0"))
    return { ok: false, reject: `NUL byte in entry name: ${JSON.stringify(entryName)}` };
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    return { ok: false, reject: `absolute path in archive: ${entryName}` };
  }
  const parts = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) {
    return { ok: false, reject: `path traversal in archive: ${entryName}` };
  }
  if (parts.length === 0) return { ok: false, skip: "empty name" };
  if (parts[0] === "__MACOSX") return { ok: false, skip: "macOS resource fork" };
  if (parts.length > maxDepth) return { ok: false, skip: "deeper than the depth limit" };
  const segments: string[] = [];
  for (const p of parts) {
    let s = p
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we strip
      .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
      .replace(/[.\s]+$/g, "");
    if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
    if (!s) return { ok: false, skip: "name empty after sanitising" };
    segments.push(s);
  }
  return { ok: true, segments };
}

/** Unix mode lives in the high 16 bits of the external attributes; 0xA000 is a symlink. */
export function isSymlinkEntry(entry: AdmZip.IZipEntry): boolean {
  const attr = entry.attr >>> 0;
  return ((attr >>> 16) & 0xf000) === 0xa000;
}

type EntryTable = Map<string, { entryName: string; kind: "file" | "dir" }>;

/**
 * Record an entry's sanitised path and the folders it implies; return the earlier entry it
 * conflicts with: a file where a folder is needed (or the reverse), or the same file twice.
 * Keys are lower-cased because names that differ only by case collide on Windows, so such
 * archives are refused on every OS and an import behaves the same everywhere.
 */
export function recordZipEntry(
  seen: EntryTable,
  segments: string[],
  isDirectory: boolean,
  entryName: string,
): string | null {
  for (let i = 1; i <= segments.length; i++) {
    const key = segments.slice(0, i).join("/").toLowerCase();
    const kind = i < segments.length || isDirectory ? "dir" : "file";
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, { entryName, kind });
      continue;
    }
    if (prior.kind !== kind || kind === "file") return prior.entryName;
  }
  return null;
}

export class DataImporter {
  private readonly clock: Clock;
  private readonly logger = log("data:import");

  constructor(private readonly deps: DataImporterDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  async importZip(
    zipPath: string,
    projectId: string,
    opts: ImportOptions = {},
  ): Promise<ImportResultView> {
    const limits = this.deps.assets.limits;
    const abs = this.checkSource(zipPath, "file");
    await this.checkProject(projectId);
    let zip: AdmZip;
    try {
      zip = new AdmZip(abs);
    } catch (e) {
      throw new ForerunnerError("validation", `not a readable ZIP archive: ${abs}`, { cause: e });
    }
    const entries = zip.getEntries();
    if (entries.length > limits.maxEntries) {
      throw new ForerunnerError(
        "validation",
        `archive has ${entries.length} entries; the limit is ${limits.maxEntries}`,
        {
          details: { entries: entries.length, maxEntries: limits.maxEntries },
        },
      );
    }
    // Pass 1: validate every name, the declared sizes and name conflicts before anything
    // touches the disk.
    const plan: { entry: AdmZip.IZipEntry; segments: string[] }[] = [];
    const skipped: { rel: string; reason: string }[] = [];
    const seen: EntryTable = new Map();
    let declared = 0;
    for (const entry of entries) {
      const check = checkZipEntryName(entry.entryName, limits.maxDepth);
      if (!check.ok) {
        if ("reject" in check)
          throw new ForerunnerError("validation", check.reject, {
            details: { entry: entry.entryName },
          });
        skipped.push({ rel: entry.entryName, reason: check.skip });
        continue;
      }
      if (isSymlinkEntry(entry)) {
        skipped.push({ rel: entry.entryName, reason: "symlink" });
        continue;
      }
      const conflictsWith = recordZipEntry(
        seen,
        check.segments,
        entry.isDirectory,
        entry.entryName,
      );
      if (conflictsWith !== null) {
        throw new ForerunnerError(
          "validation",
          `conflicting entries in archive: ${entry.entryName} and ${conflictsWith}`,
          { details: { entry: entry.entryName, conflictsWith } },
        );
      }
      if (!entry.isDirectory) {
        declared += entry.header.size;
        if (declared > limits.maxTotalBytes) {
          throw new ForerunnerError(
            "validation",
            `archive declares more than ${limits.maxTotalBytes} bytes`,
            {
              details: { maxTotalBytes: limits.maxTotalBytes },
            },
          );
        }
      }
      plan.push({ entry, segments: check.segments });
    }
    const destRoot = this.importDestination(projectId, basename(abs, extname(abs)));
    mkdirSync(destRoot, { recursive: true });
    const imported: ImportedFile[] = [];
    let totalBytes = 0;
    try {
      for (const { entry, segments } of plan) {
        const dest = join(destRoot, ...segments);
        if (!isInside(destRoot, dest) || normalize(dest) === normalize(destRoot)) {
          throw new ForerunnerError(
            "validation",
            `entry escapes the destination: ${entry.entryName}`,
          );
        }
        if (entry.isDirectory) {
          mkdirSync(dest, { recursive: true });
          continue;
        }
        const data = entry.getData();
        totalBytes += data.length;
        if (totalBytes > limits.maxTotalBytes) {
          throw new ForerunnerError(
            "validation",
            `archive expands beyond ${limits.maxTotalBytes} bytes`,
            {
              details: { maxTotalBytes: limits.maxTotalBytes },
            },
          );
        }
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, data, { mode: 0o600 });
        imported.push({ rel: segments.join("/"), sizeBytes: data.length, assetId: null });
      }
    } catch (e) {
      rmSync(destRoot, { recursive: true, force: true });
      throw e;
    }
    imported.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    if (opts.register !== false) {
      for (const f of imported) {
        const view = await this.deps.assets.register(
          { projectId, source: join(destRoot, ...f.rel.split("/")), kind: "file", mode: "link" },
          opts.actor ?? {},
          { audit: false },
        );
        f.assetId = view.id;
      }
    }
    const gitignore = opts.worktreePath
      ? ensureDataDirIgnored(opts.worktreePath, this.deps.assets.projectDataDir(projectId))
      : null;
    await this.audit(
      opts.actor ?? {},
      "data.import",
      `zip ${basename(abs)} -> ${imported.length} files, ${skipped.length} skipped`,
      destRoot,
    );
    this.logger.info("zip imported", {
      projectId,
      files: imported.length,
      skipped: skipped.length,
      totalBytes,
    });
    return {
      source: "zip",
      projectId,
      destination: destRoot,
      imported,
      skipped,
      totalBytes,
      entryCount: entries.length,
      gitignore,
      note: null,
      repository: null,
    };
  }

  async importFolder(
    folderPath: string,
    projectId: string,
    opts: ImportOptions = {},
  ): Promise<ImportResultView> {
    const limits = this.deps.assets.limits;
    const abs = this.checkSource(folderPath, "folder");
    await this.checkProject(projectId);
    const walk = walkFolder(abs, {
      maxEntries: limits.maxEntries,
      maxTotalBytes: limits.maxTotalBytes,
      maxDepth: limits.maxDepth,
    });
    if (walk.truncated) {
      throw new ForerunnerError("validation", `folder exceeds the import ${walk.limit} limit`, {
        details: {
          limit: walk.limit,
          maxEntries: limits.maxEntries,
          maxTotalBytes: limits.maxTotalBytes,
          maxDepth: limits.maxDepth,
        },
      });
    }
    let destination: string | null = null;
    let note: string | null = null;
    if (opts.copy) {
      if (walk.totalBytes > limits.copyThresholdBytes) {
        note = `Linked in place: ${walk.totalBytes} bytes is above the copy threshold of ${limits.copyThresholdBytes}. Large data never goes into git; keep it at its original location, in Git LFS or in an R2/S3 bucket.`;
      } else {
        destination = this.importDestination(projectId, basename(abs));
        mkdirSync(destination, { recursive: true });
        for (const f of walk.files) {
          const dest = join(destination, ...f.rel.split("/"));
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(f.path, dest);
        }
      }
    }
    const imported: ImportedFile[] = walk.files.map((f) => ({
      rel: f.rel,
      sizeBytes: f.sizeBytes,
      assetId: null,
    }));
    if (opts.register !== false) {
      for (const f of imported) {
        const source = destination
          ? join(destination, ...f.rel.split("/"))
          : join(abs, ...f.rel.split("/"));
        const view = await this.deps.assets.register(
          { projectId, source, kind: "file", mode: "link" },
          opts.actor ?? {},
          { audit: false },
        );
        f.assetId = view.id;
      }
    }
    const gitignore = opts.worktreePath
      ? ensureDataDirIgnored(opts.worktreePath, this.deps.assets.projectDataDir(projectId))
      : null;
    await this.audit(
      opts.actor ?? {},
      "data.import",
      `folder ${basename(abs)} -> ${imported.length} files ${destination ? "copied" : "linked"}, ${walk.skipped.length} skipped`,
      destination ?? abs,
    );
    this.logger.info("folder imported", {
      projectId,
      files: imported.length,
      copied: destination !== null,
    });
    return {
      source: "folder",
      projectId,
      destination,
      imported,
      skipped: walk.skipped,
      totalBytes: walk.totalBytes,
      entryCount: walk.files.length + walk.dirs,
      gitignore,
      note,
      repository: null,
    };
  }

  /**
   * Import an existing GitHub repository (spec A.3; ADR 0069): clone it (full history, no
   * tags) into `<projectsRoot>/<project>/repos/<owner>/<name>`, open the migration branch
   * `forerunner/migration-<date>` from the remote's default branch, register the checkout as
   * one folder asset and link `owner/name` on the project. The default branch is never checked
   * out, committed to or pushed; the import pushes nothing. A token reaches git only through
   * the process environment, resolved from the vault by reference at call time. A second import
   * of the same repository into the same project fetches, keeps the worktree and the migration
   * branch it finds (with its commits) and adds no second row or link.
   */
  async importGitHubRepo(
    input: GitHubImportInput,
    projectId: string,
    opts: Pick<ImportOptions, "actor" | "register"> = {},
  ): Promise<ImportResultView> {
    const limits = this.deps.assets.limits;
    const target = parseRepositorySource(input.repo, this.deps.gitRemoteBase);
    const tokenRef = await this.pickTokenRef(input.tokenRef, target.url);
    await this.checkProject(projectId);
    const token = tokenRef ? await this.resolveToken(tokenRef) : null;
    const dir = join(
      this.deps.assets.projectReposDir(projectId),
      safeSegment(target.owner, "owner"),
      safeSegment(target.name, "repo"),
    );
    // The header carrying the token is scoped to the repository's origin (ADR 0069): git
    // attaches it to no other host, whatever a remote's config or an insteadOf rewrite says.
    const git = new GitOps({
      cwd: dir,
      auth: token ? { token, origin: new URL(target.url).origin } : undefined,
      timeoutMs: this.deps.gitTimeoutMs ?? 10 * 60 * 1000,
    });
    const existed = existsSync(join(dir, ".git"));
    if (existed) {
      // The directory is keyed on owner/name alone: the same slug on another host must not
      // quietly reuse (and fetch) somebody else's checkout.
      const remote = await git.remoteUrl();
      if (remote === null || !sameRepository(remote, target.url)) {
        const shown = remote === null ? "no remote" : withoutUserinfo(remote);
        throw new ForerunnerError(
          "validation",
          `the checkout for ${target.slug} at ${dir} belongs to ${shown}, not ${target.url}; import that repository by its own URL or remove the checkout first`,
          { details: { slug: target.slug, worktree: dir, url: target.url, remote: shown } },
        );
      }
    } else {
      mkdirSync(dirname(dir), { recursive: true });
    }
    let defaultBranch: string;
    let branch: string | null = null;
    let created = false;
    let headSha: string;
    try {
      if (existed) await git.fetch();
      else await git.clone(target.url);
      defaultBranch = await git.remoteDefaultBranch();
      // The migration branch: the one the checkout already sits on, else the newest one made
      // earlier, else a new one from today's date, always from the default branch's remote head.
      if (existed) {
        const current = await git.currentBranch();
        if (current.startsWith(MIGRATION_BRANCH_PREFIX)) branch = current;
        else {
          const earlier = await git.localBranches(MIGRATION_BRANCH_PREFIX);
          const newest = earlier[earlier.length - 1];
          if (newest) {
            await git.checkout(newest);
            branch = newest;
          }
        }
      }
      if (branch === null) {
        branch = migrationBranchName(this.clock);
        created = true;
        await git.createBranch(branch, `origin/${defaultBranch}`);
      }
      // Enforced in code, not by naming: the checkout never ends up on the default branch.
      const onBranch = await git.currentBranch();
      if (onBranch === defaultBranch || onBranch !== branch) {
        throw new ForerunnerError(
          "internal",
          `the checkout is on ${onBranch}, not the migration branch ${branch}`,
          { details: { branch, defaultBranch, worktree: dir } },
        );
      }
      headSha = await git.headSha();
    } catch (e) {
      // A fresh clone that did not reach the migration branch (a refused checkout, an empty
      // repository, a clone killed at the time limit) leaves nothing behind; a checkout that
      // was already there is kept as it was.
      if (!existed) rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const reused = !created;

    const walk = walkFolder(dir, {
      maxEntries: limits.maxEntries,
      maxTotalBytes: limits.maxTotalBytes,
      maxDepth: limits.maxDepth,
    });
    const imported: ImportedFile[] = walk.files.map((f) => ({
      rel: f.rel,
      sizeBytes: f.sizeBytes,
      assetId: null,
    }));
    const note = walk.truncated
      ? truncatedWalkNote(
          walk.limit ?? "entries",
          walk.limit === "bytes"
            ? limits.maxTotalBytes
            : walk.limit === "depth"
              ? limits.maxDepth
              : limits.maxEntries,
        )
      : null;

    let assetId: string | null = null;
    if (opts.register !== false) {
      const prior = await this.deps.store.dataAsset.byLocator(dir);
      if (prior?.project_ids.includes(projectId)) assetId = prior.id;
      else {
        const view = await this.deps.assets.register(
          { projectId, source: dir, kind: "folder", mode: "link", name: target.slug },
          opts.actor ?? {},
          { audit: false },
        );
        assetId = view.id;
      }
    }
    const project = await this.deps.store.project.mustGet(projectId);
    if (!project.repos.includes(target.slug)) {
      await this.deps.store.project.patch(projectId, { repos: [...project.repos, target.slug] });
    }
    await this.audit(
      opts.actor ?? {},
      "data.import",
      `github ${target.slug} -> ${branch}${reused ? " (kept)" : ""} from ${defaultBranch}, ${imported.length} files${tokenRef ? `, ${tokenRef}` : ""}`,
      dir,
    );
    this.logger.info("github repository imported", {
      projectId,
      slug: target.slug,
      branch,
      defaultBranch,
      reused,
      files: imported.length,
      tokenRef,
    });
    return {
      source: "github",
      projectId,
      destination: dir,
      imported,
      // The clone's own `.git` is not user content; every other skip is reported.
      skipped: walk.skipped.filter((e) => e.rel !== ".git"),
      totalBytes: walk.totalBytes,
      entryCount: walk.files.length + walk.dirs,
      gitignore: null,
      note,
      repository: {
        slug: target.slug,
        url: target.url,
        worktree: dir,
        branch,
        defaultBranch,
        headSha,
        assetId,
        reused,
      } satisfies RepositoryImportView,
    };
  }

  /**
   * The reference to use: the caller's (for any host: naming it is the human's choice), else
   * the install's default when the vault holds it and the clone URL is on the git host that
   * token belongs to (`gitRemoteBase`'s origin). Another origin is cloned anonymously, so a
   * request naming some other server never receives the install's GitHub token.
   */
  private async pickTokenRef(named: string | undefined, url: string): Promise<string | null> {
    if (named !== undefined) {
      parseSecretRef(named);
      return named;
    }
    const fallback = this.deps.defaultTokenRef;
    if (!fallback || !this.deps.vault) return null;
    const home = new URL(this.deps.gitRemoteBase ?? DEFAULT_GIT_REMOTE_BASE).origin;
    if (new URL(url).origin !== home) return null;
    return (await this.deps.vault.has(parseSecretRef(fallback))) ? fallback : null;
  }

  /** The vault value for a reference; the name is granted for this one call, never logged as a value. */
  private async resolveToken(ref: string): Promise<string> {
    const name = parseSecretRef(ref);
    if (!this.deps.vault) {
      throw new ForerunnerError(
        "not_supported",
        `a repository token needs a vault to resolve ${ref}; this importer has none`,
        { details: { tokenRef: ref } },
      );
    }
    const resolved = (await resolveSecretRefs({ token: ref }, this.deps.vault, new Set([name]), {
      audit: (n) => this.logger.debug("resolved secret reference", { name: n }),
    })) as { token: string };
    return resolved.token;
  }

  private importDestination(projectId: string, name: string): string {
    const suffix = newId(this.clock.now()).slice(-12);
    return join(
      this.deps.assets.projectDataDir(projectId),
      "imports",
      `${safeSegment(name, "import")}-${suffix}`,
    );
  }

  private checkSource(p: string, expect: "file" | "folder"): string {
    if (!p.trim() || !isAbsolute(p)) {
      throw new ForerunnerError("validation", `import source must be an absolute path: ${p}`);
    }
    const abs = normalize(resolve(p));
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      throw new ForerunnerError("not_found", `no ${expect} at ${abs}`, {
        details: { source: abs },
      });
    }
    if (st.isSymbolicLink())
      throw new ForerunnerError("validation", `symlinks are never imported: ${abs}`);
    if (expect === "file" && !st.isFile())
      throw new ForerunnerError("validation", `not a file: ${abs}`);
    if (expect === "folder" && !st.isDirectory())
      throw new ForerunnerError("validation", `not a folder: ${abs}`);
    return abs;
  }

  private async checkProject(projectId: string): Promise<void> {
    if (!(await this.deps.store.project.exists(projectId))) {
      throw new ForerunnerError("not_found", `project ${projectId} not found`, {
        details: { projectId },
      });
    }
  }

  private async audit(
    actor: DataActor,
    tool: string,
    inputSummary: string,
    resultSummary: string,
  ): Promise<void> {
    await this.deps.store.auditLog.append({
      session_id: actor.sessionId ?? null,
      run_id: actor.runId ?? null,
      agent_id: actor.agentId ?? null,
      human_id: actor.humanId ?? null,
      tool,
      input_summary: inputSummary.slice(0, 500),
      result_summary: resultSummary.slice(0, 500),
      allowed: true,
      denied_reason: null,
      cost_usd_micro: 0,
      token_id: null,
    });
  }
}

/**
 * Make sure the worktree's `.gitignore` covers the project data dir: the in-worktree
 * convention `/.forerunner-data/` always, plus the data dir's own relative path when it lies
 * inside the worktree. Idempotent; creates the file when missing.
 */
export function ensureDataDirIgnored(worktreePath: string, dataDir: string): GitignoreGuardResult {
  const wt = normalize(resolve(worktreePath));
  if (!existsSync(wt) || !lstatSync(wt).isDirectory()) {
    throw new ForerunnerError("validation", `worktree is not a directory: ${wt}`);
  }
  const patterns = [`/${WORKTREE_DATA_DIR}/`];
  const dd = normalize(resolve(dataDir));
  if (isInside(wt, dd) && normalize(dd) !== wt) {
    patterns.push(`/${toPosix(relative(wt, dd))}/`);
  }
  const path = join(wt, ".gitignore");
  const existing = existsSync(path) ? normalizeNewlines(readFileSync(path, "utf8")) : "";
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const covers = (p: string) => {
    const bare = p.replace(/^\//, "").replace(/\/$/, "");
    return (
      present.has(p) || present.has(bare) || present.has(`/${bare}`) || present.has(`${bare}/`)
    );
  };
  const added = patterns.filter((p) => !covers(p));
  if (added.length > 0) {
    const head = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const block = `${head}# Forerunner: project data never goes into git (use LFS, R2 or the original location)\n${added.join("\n")}\n`;
    writeFileSync(path, existing + block);
  }
  return { path, added };
}
