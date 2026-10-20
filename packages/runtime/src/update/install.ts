import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import {
  type AppDirs,
  type Clock,
  currentPlatform,
  dirname,
  errorMessage,
  ForerunnerError,
  fromPosix,
  isInside,
  join,
  log,
  newId,
  type Platform,
  resolve,
  safeSegment,
} from "@forerunner/platform";
import type { AuditLogRepo, ReleaseRepo, ReleaseRow } from "@forerunner/state";
import AdmZip from "adm-zip";
import type { UpdateConfig } from "./config.ts";
import type { ReleaseFeed } from "./feed.ts";
import { type HealthOutcome, type HealthProbe, runStartupHealthCheck } from "./health.ts";
import {
  type ArtifactPlatform,
  artifactFor,
  artifactKind,
  type ReleaseArtifact,
  type ReleaseManifest,
  type SignedManifest,
} from "./manifest.ts";
import {
  assertInsideVersions,
  type CurrentPointer,
  cleanStalePointerTemps,
  listVersionDirs,
  readPointer,
  versionDir,
  versionsRoot,
  writePointer,
} from "./pointer.ts";
import type { Restarter, UpdateHumanPort } from "./ports.ts";
import { compareSemver } from "./semver.ts";
import { type ReleaseVerifier, refusal, refusalReason, type VerifyRefusal } from "./verify.ts";

/**
 * Staged install (spec M, ADR 0015). `apply` downloads the artefact for this platform into a
 * staging directory under <data>/versions, verifies size and SHA-256 against the signed
 * manifest, unpacks zip artefacts (zip-slip and symlink entries refused), renames the staging
 * directory into place, records the release row, writes current.json atomically with the
 * health check pending, audits, and asks the shell to restart. Config, memory and the rest of
 * the data directory are never written: every path goes through assertInsideVersions.
 */
export interface UpdateActor {
  kind: "human" | "agent" | "system";
  id: string | null;
}

export interface UpdateManagerDeps {
  dirs: AppDirs;
  clock: Clock;
  feed: ReleaseFeed;
  verifier: ReleaseVerifier;
  store: { release: ReleaseRepo; auditLog: AuditLogRepo };
  human: UpdateHumanPort;
  restarter: Restarter;
  probe: HealthProbe;
  config: Pick<UpdateConfig, "channel" | "allowDowngrade" | "healthTimeoutMs">;
  /** Version of the running build (package version), or a function when it can change. */
  runningVersion: string | (() => string);
  /** schema_migrations version of the local state store. */
  localSchemaVersion: number;
  platform?: ArtifactPlatform;
  fetchImpl?: typeof fetch;
  humanId?: string | null;
}

export interface RejectedRelease {
  version: string;
  reason: VerifyRefusal | "error";
  message: string;
}

export interface UpdateCheck {
  runningVersion: string;
  channel: UpdateConfig["channel"];
  /** Newest verified release that is newer than the running one (or allowed as a downgrade). */
  available: ReleaseManifest | null;
  signed: SignedManifest | null;
  rejected: RejectedRelease[];
  checkedAt: string;
}

export interface StagedInstall {
  version: string;
  dir: string;
  artifact: ReleaseArtifact;
  /** Files written by unpacking (0 for non-zip artefacts, which are kept as one file). */
  unpackedFiles: number;
  manifestPath: string;
}

export interface ApplyResult {
  version: string;
  previous: string | null;
  staged: StagedInstall;
  release: ReleaseRow;
  pointer: CurrentPointer;
}

export interface RollbackResult {
  from: string;
  to: string;
  pointer: CurrentPointer;
}

export interface UpdateStatus {
  runningVersion: string;
  channel: UpdateConfig["channel"];
  platform: ArtifactPlatform | null;
  pointer: CurrentPointer | null;
  versionsOnDisk: string[];
  trustedKeyIds: string[];
}

const logger = log("update:install");
export const RELEASE_RECORD_FILE = "release.json";
export const DOWNLOAD_DIR = "download";

export function detectArtifactPlatform(
  platform: Platform = currentPlatform(),
  arch: string = os.arch(),
): ArtifactPlatform {
  if (platform === "android") return "android";
  if (arch === "x64") {
    if (platform === "windows") return "windows-x64";
    if (platform === "linux") return "linux-x64";
  }
  throw new ForerunnerError("not_supported", `no release artefact for ${platform}/${arch}`, {
    details: { platform, arch },
  });
}

const BAD_ENTRY = /(^|\/)\.\.(\/|$)/;

/** Refuse zip entries that would escape the target directory or create links. */
export function assertSafeZipEntry(name: string, attr: number): void {
  const bad = (why: string) =>
    new ForerunnerError("path_not_allowed", `zip entry refused (${why}): ${name.slice(0, 120)}`, {
      details: { entry: name.slice(0, 120), why },
    });
  if (!name || name.includes("\0")) throw bad("empty or NUL");
  if (name.includes("\\")) throw bad("backslash");
  if (name.startsWith("/")) throw bad("absolute");
  if (/^[A-Za-z]:/.test(name)) throw bad("drive letter");
  if (BAD_ENTRY.test(name)) throw bad("parent directory");
  // Unix external attributes: file type in the high 16 bits; 0o120000 is a symlink.
  if (((attr >>> 16) & 0o170000) === 0o120000) throw bad("symlink");
}

/** Unpack a zip into `targetDir`, refusing zip-slip and link entries. Returns files written. */
export function unpackZip(zipPath: string, targetDir: string): number {
  const zip = new AdmZip(zipPath);
  const root = resolve(targetDir);
  mkdirSync(root, { recursive: true });
  let files = 0;
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    assertSafeZipEntry(name, entry.header.attr);
    const dest = resolve(root, fromPosix(name));
    if (!isInside(root, dest) || dest === root)
      throw new ForerunnerError("path_not_allowed", `zip entry escapes the target: ${name}`);
    if (entry.isDirectory) {
      mkdirSync(dest, { recursive: true });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.getData());
    files++;
  }
  return files;
}

/** Stream a download to disk while hashing; more bytes than the manifest says is tampering. */
export async function downloadToFile(
  f: typeof fetch,
  artifact: ReleaseArtifact,
  dest: string,
): Promise<{ size: number; sha256: string }> {
  let res: Response;
  try {
    res = await f(artifact.url, { headers: { "User-Agent": "forerunner-updater" } });
  } catch (e) {
    throw new ForerunnerError("unavailable", `download failed: ${errorMessage(e)}`, {
      details: { url: artifact.url },
      retryable: true,
    });
  }
  if (!res.ok || !res.body) {
    throw new ForerunnerError("unavailable", `download answered ${res.status}: ${artifact.url}`, {
      details: { url: artifact.url, status: res.status },
      retryable: res.status >= 500,
    });
  }
  const hash = createHash("sha256");
  let size = 0;
  const fd = openSync(dest, "w");
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > artifact.size) {
        await reader.cancel().catch(() => undefined);
        throw refusal(
          "tampered",
          `artefact ${artifact.name} is larger than the manifest says (${artifact.size} bytes)`,
          { name: artifact.name, expectedSize: artifact.size },
        );
      }
      hash.update(value);
      writeSync(fd, value);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { size, sha256: hash.digest("hex") };
}

export class UpdateManager {
  readonly platform: ArtifactPlatform | null;
  private readonly f: typeof fetch;

  constructor(private readonly deps: UpdateManagerDeps) {
    this.f = deps.fetchImpl ?? fetch;
    let platform: ArtifactPlatform | null = deps.platform ?? null;
    if (!platform) {
      try {
        platform = detectArtifactPlatform();
      } catch {
        platform = null;
      }
    }
    this.platform = platform;
  }

  get channel(): UpdateConfig["channel"] {
    return this.deps.config.channel;
  }

  get runningVersion(): string {
    const v = this.deps.runningVersion;
    return typeof v === "function" ? v() : v;
  }

  /** The version current.json names, else the running build. */
  installedVersion(): string {
    return readPointer(this.deps.dirs)?.current ?? this.runningVersion;
  }

  private now(): string {
    return this.deps.clock.nowIso();
  }

  private async audit(
    tool: string,
    by: UpdateActor,
    allowed: boolean,
    input: string,
    result: string,
    deniedReason?: string,
  ): Promise<void> {
    await this.deps.store.auditLog.append({
      tool,
      allowed,
      input_summary: input,
      result_summary: result,
      denied_reason: deniedReason ?? null,
      human_id: by.kind === "human" ? by.id : (this.deps.humanId ?? null),
      agent_id: by.kind === "agent" ? by.id : null,
      occurred_at: this.now(),
    });
  }

  /** Verify a feed document against the trust rules; throws with details.reason on refusal. */
  private verifyCandidate(signed: SignedManifest, opts: { allowDowngrade?: boolean } = {}) {
    const { manifest, keyId } = this.deps.verifier.verifyManifest(signed);
    this.deps.verifier.assertNotDowngrade(
      manifest.version,
      this.installedVersion(),
      opts.allowDowngrade ?? this.deps.config.allowDowngrade,
    );
    this.deps.verifier.assertSchemaCompatible(manifest, this.deps.localSchemaVersion);
    return { manifest, keyId };
  }

  /** Ask the feed and report the newest release this install may take. */
  async check(by: UpdateActor = { kind: "system", id: null }): Promise<UpdateCheck> {
    const channel = this.deps.config.channel;
    const list = await this.deps.feed.list(channel);
    const rejected: RejectedRelease[] = [];
    let available: ReleaseManifest | null = null;
    let signed: SignedManifest | null = null;
    const current = this.installedVersion();
    for (const candidate of list) {
      const version = candidate.manifest.version;
      // "Available" always means newer; downgrades are explicit (apply --version).
      if (compareSemver(version, current) <= 0) break;
      try {
        const { manifest } = this.verifyCandidate(candidate);
        await this.assertNotRejectedBefore(manifest);
        available = manifest;
        signed = candidate;
        break;
      } catch (e) {
        rejected.push({ version, reason: refusalReason(e) ?? "error", message: errorMessage(e) });
      }
    }
    await this.audit(
      "update.check",
      by,
      true,
      `feed ${this.deps.feed.kind}, channel ${channel}`,
      available
        ? `update available: ${available.version}`
        : `up to date at ${current}${rejected.length ? `; rejected ${rejected.map((r) => `${r.version} (${r.reason})`).join(", ")}` : ""}`,
    );
    return { runningVersion: current, channel, available, signed, rejected, checkedAt: this.now() };
  }

  /** Download, verify and unpack into <versions>/<version>. Does not touch current.json. */
  async stage(
    signed: SignedManifest,
    opts: { allowDowngrade?: boolean } = {},
  ): Promise<StagedInstall> {
    const { manifest } = this.verifyCandidate(signed, opts);
    if (!this.platform)
      throw new ForerunnerError("not_supported", "no release artefact for this platform");
    const artifact = artifactFor(manifest, this.platform);
    if (!artifact) {
      throw new ForerunnerError(
        "not_found",
        `release ${manifest.version} has no artefact for ${this.platform}`,
        { details: { version: manifest.version, platform: this.platform } },
      );
    }
    const dirs = this.deps.dirs;
    const finalDir = assertInsideVersions(dirs, versionDir(dirs, manifest.version));
    const staging = assertInsideVersions(
      dirs,
      join(versionsRoot(dirs), `.staging-${safeSegment(manifest.version)}-${newId()}`),
    );
    mkdirSync(join(staging, DOWNLOAD_DIR), { recursive: true });
    try {
      const downloadPath = assertInsideVersions(
        dirs,
        join(staging, DOWNLOAD_DIR, safeSegment(artifact.name, "artifact")),
      );
      const got = await downloadToFile(this.f, artifact, downloadPath);
      this.deps.verifier.assertArtifactMatches(artifact, got.size, got.sha256);
      let unpackedFiles = 0;
      if (artifactKind(artifact.name) === "zip") {
        unpackedFiles = unpackZip(downloadPath, staging);
        rmSync(join(staging, DOWNLOAD_DIR), { recursive: true, force: true });
      } else {
        renameSync(downloadPath, join(staging, safeSegment(artifact.name, "artifact")));
        rmSync(join(staging, DOWNLOAD_DIR), { recursive: true, force: true });
      }
      const manifestPath = assertInsideVersions(dirs, join(staging, RELEASE_RECORD_FILE));
      writeFileSync(manifestPath, `${JSON.stringify(signed, null, 2)}\n`);
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
      renameSync(staging, finalDir);
      logger.info("release staged", { version: manifest.version, dir: finalDir, unpackedFiles });
      return {
        version: manifest.version,
        dir: finalDir,
        artifact,
        unpackedFiles,
        manifestPath: join(finalDir, RELEASE_RECORD_FILE),
      };
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
  }

  private async requireApproval(by: UpdateActor, what: string, why: string): Promise<void> {
    if (by.kind !== "agent") return;
    const answer = await this.deps.human.ask({
      kind: "approval",
      why: `${what}: ${why}`,
      steps: ["Open Settings > Updates", `Review the changelog and ${what}`],
      risk: "high",
      blocking: true,
      humanId: this.deps.humanId ?? null,
    });
    if (answer.outcome !== "approved") {
      await this.audit(
        "update.apply",
        by,
        false,
        what,
        `not approved (${answer.outcome})`,
        answer.outcome,
      );
      throw new ForerunnerError("approval_required", `${what} needs a human's approval`, {
        details: { outcome: answer.outcome, requestId: answer.requestId ?? null },
      });
    }
  }

  private async existingRow(m: ReleaseManifest): Promise<ReleaseRow | undefined> {
    const [row] = await this.deps.store.release.list(
      { channel: m.channel, release_version: m.version },
      { limit: 1 },
    );
    return row;
  }

  /** A release that rolled back or failed on this install is never offered or installed again. */
  private async assertNotRejectedBefore(m: ReleaseManifest): Promise<void> {
    const existing = await this.existingRow(m);
    if (existing && (existing.status === "rolled_back" || existing.status === "failed")) {
      throw refusal(
        "previously_rejected",
        `release ${m.version} was ${existing.status.replace("_", " ")} on this install before; cut a new release`,
        { version: m.version, status: existing.status },
      );
    }
  }

  private async recordRelease(signed: SignedManifest, by: UpdateActor): Promise<ReleaseRow> {
    const m = signed.manifest;
    const existing = await this.existingRow(m);
    if (existing) return existing;
    return this.deps.store.release.insert({
      release_version: m.version,
      channel: m.channel,
      changelog: m.notes,
      signature: signed.signature ? JSON.stringify(signed.signature) : "",
      status: "published",
      artifacts: m.artifacts,
      published_at: m.publishedAt,
      author_human: by.kind === "human" ? by.id : null,
      author_agent: by.kind === "agent" ? by.id : "updater",
    });
  }

  /**
   * "Update and restart": stage the release, record it, point current.json at it with the
   * health check pending, audit, restart. An agent needs a human's approval first.
   */
  async apply(opts: { by: UpdateActor; version?: string }): Promise<ApplyResult> {
    const { by } = opts;
    let signed: SignedManifest | null;
    if (opts.version) {
      const list = await this.deps.feed.list(this.deps.config.channel);
      signed = list.find((r) => r.manifest.version === opts.version) ?? null;
      if (!signed) {
        throw new ForerunnerError(
          "not_found",
          `release ${opts.version} is not on the ${this.deps.config.channel} channel`,
          {
            details: { version: opts.version, channel: this.deps.config.channel },
          },
        );
      }
    } else {
      signed = (await this.check(by)).signed;
      if (!signed) throw new ForerunnerError("not_found", "no update available");
    }
    const target = signed.manifest.version;
    await this.requireApproval(by, `install update ${target}`, signed.manifest.notes.slice(0, 200));
    let staged: StagedInstall;
    try {
      await this.assertNotRejectedBefore(signed.manifest);
      staged = await this.stage(signed);
    } catch (e) {
      await this.audit(
        "update.apply",
        by,
        false,
        `install ${target}`,
        errorMessage(e),
        refusalReason(e) ?? "error",
      );
      throw e;
    }
    const release = await this.recordRelease(signed, by);
    const before = readPointer(this.deps.dirs);
    const previous = before?.current ?? this.runningVersion;
    cleanStalePointerTemps(this.deps.dirs);
    const pointer: CurrentPointer = {
      schema: 1,
      current: target,
      previous: previous === target ? (before?.previous ?? null) : previous,
      state: "pending_health_check",
      updatedAt: this.now(),
      lastRollback: before?.lastRollback ?? null,
    };
    writePointer(this.deps.dirs, pointer);
    await this.audit(
      "update.apply",
      by,
      true,
      `install ${target} from ${this.deps.feed.kind} (${staged.artifact.name}, ${staged.artifact.size} bytes)`,
      `staged in ${staged.dir}; previous ${pointer.previous ?? "none"}; restart requested`,
    );
    await this.deps.restarter.restart({
      reason: "update",
      targetVersion: target,
      fromVersion: pointer.previous,
    });
    return { version: target, previous: pointer.previous, staged, release, pointer };
  }

  /** Manual rollback to the previous version named in current.json. */
  async rollback(opts: { by: UpdateActor; reason?: string }): Promise<RollbackResult> {
    const { by } = opts;
    const pointer = readPointer(this.deps.dirs);
    if (!pointer?.current || !pointer.previous) {
      throw new ForerunnerError("not_found", "no previous version to roll back to", {
        details: { pointer },
      });
    }
    const reason = opts.reason ?? "manual rollback";
    await this.requireApproval(by, `roll back ${pointer.current} to ${pointer.previous}`, reason);
    const from = pointer.current;
    const to = pointer.previous;
    const next: CurrentPointer = {
      schema: 1,
      current: to,
      previous: null,
      state: "installed",
      updatedAt: this.now(),
      lastRollback: { from, to, reason, at: this.now(), automatic: false },
    };
    writePointer(this.deps.dirs, next);
    const [row] = await this.deps.store.release.list(
      { release_version: from },
      { orderBy: "created_at desc", limit: 1 },
    );
    if (row && (row.status === "published" || row.status === "installed")) {
      await this.deps.store.release.setStatus(row.id, row.version, "rolled_back", {
        ok: false,
        detail: reason,
        manual: true,
        checkedAt: this.now(),
      });
    }
    await this.audit(
      "update.rollback",
      by,
      true,
      `roll back ${from}: ${reason}`,
      `now ${to}; restart requested`,
    );
    await this.deps.human.notify({
      title: `Rolled back ${from} to ${to}`,
      body: reason,
      severity: "warning",
      humanId: this.deps.humanId ?? null,
    });
    await this.deps.restarter.restart({ reason: "rollback", targetVersion: to, fromVersion: from });
    return { from, to, pointer: next };
  }

  /** The startup health check (health.ts) with this manager's wiring. */
  healthCheck(): Promise<HealthOutcome> {
    return runStartupHealthCheck({
      dirs: this.deps.dirs,
      clock: this.deps.clock,
      probe: this.deps.probe,
      timeoutMs: this.deps.config.healthTimeoutMs,
      store: this.deps.store,
      human: this.deps.human,
      restarter: this.deps.restarter,
      runningVersion: this.runningVersion,
      humanId: this.deps.humanId ?? null,
    });
  }

  status(): UpdateStatus {
    return {
      runningVersion: this.runningVersion,
      channel: this.deps.config.channel,
      platform: this.platform,
      pointer: readPointer(this.deps.dirs),
      versionsOnDisk: listVersionDirs(this.deps.dirs),
      trustedKeyIds: this.deps.verifier.trustedKeyIds,
    };
  }

  /** Remove version directories that are neither current nor previous. Returns what went. */
  prune(): string[] {
    const pointer = readPointer(this.deps.dirs);
    const keep = new Set([pointer?.current, pointer?.previous].filter((v): v is string => !!v));
    const removed: string[] = [];
    for (const name of listVersionDirs(this.deps.dirs)) {
      if (keep.has(name)) continue;
      const dir = assertInsideVersions(this.deps.dirs, join(versionsRoot(this.deps.dirs), name));
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
  }
}
