import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import type { AuditLogRepo, ProjectRepo } from "@forerunner/state";
import AdmZip from "adm-zip";
import type { DataAssets } from "./assets.ts";
import type { DataActor, GitignoreGuardResult, ImportedFile, ImportResultView } from "./types.ts";
import { walkFolder } from "./walk.ts";

/**
 * ZIP and folder import (spec A.3, phase 5). A ZIP is extracted under the project data dir
 * with zip-slip, absolute-path and symlink entries refused or skipped and the entry count and
 * total size bounded; a folder is walked with the same limits and each file registered where
 * it sits (or copied when small and asked). Every file becomes a `data_asset` row. When the
 * project worktree is known, `.gitignore` gets the data dir so nothing large reaches git.
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
  store: { auditLog: AuditLogRepo; project: ProjectRepo };
  clock?: Clock;
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
    };
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
