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
import type { AuditLogRepo, JsonObject, ReleaseRepo, ReleaseRow } from "@forerunner/state";
import AdmZip from "adm-zip";
import type { UpdateConfig } from "./config.ts";
import type { ReleaseFeed } from "./feed.ts";
import { type HealthOutcome, type HealthProbe, runStartupHealthCheck } from "./health.ts";
import { withInstallLock, withInstallLockSync } from "./lock.ts";
import {
  type ArtifactPlatform,
  artifactFor,
  artifactKind,
  isInstallerArtifact,
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
  rollbackCurrent,
  versionDir,
  versionsRoot,
  writePointer,
} from "./pointer.ts";
import { type Restarter, UPDATE_REQUEST_AUTHOR, type UpdateHumanPort } from "./ports.ts";
import { compareSemver } from "./semver.ts";
import { type ReleaseVerifier, refusal, refusalReason, type VerifyRefusal } from "./verify.ts";

/**
 * Staged install (spec M, ADR 0015). `apply` downloads the artefact for this platform into a
 * staging directory under <data>/versions, verifies size and SHA-256 against the signed
 * manifest, unpacks zip artefacts (zip-slip and symlink entries refused), renames the staging
 * directory into place, records the release row, writes current.json atomically with the
 * health check pending, audits, and asks the shell to restart. Config, memory and the rest of
 * the data directory are never written: every path goes through assertInsideVersions. Apply,
 * rollback, the health check and prune run one at a time under the install lock (lock.ts),
 * across processes; a second caller is refused as in_progress, never queued.
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
  /**
   * How long a check() result is reused (the updates screen asks on every view). Default
   * 60 s; 0 disables. `check(by, { fresh: true })` always asks the feed.
   */
  checkCacheMs?: number;
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
  /** True when served from the cache: no feed request and no audit row this time. */
  cached: boolean;
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
export const DEFAULT_CHECK_CACHE_MS = 60_000;

/**
 * Who reported a rollback or a failed health check on a release row, and when. The row is
 * shared by every install on the same state (ADR 0046), so a refusal must say which install
 * reported the verdict instead of claiming it happened here.
 */
export interface RejectionReport {
  /** Human of the install that reported it, when the row names one. */
  human: string | null;
  /** Agent that applied it, when an agent did (the updater's own author name is not one). */
  agent: string | null;
  /** When the verdict was recorded: `health.checkedAt`, else the row's last update. */
  at: string;
  /**
   * True when the reporter is this install's human. The row carries no install id, so a
   * second install of the same human (a laptop beside the PC) reads as `mine` too; the
   * wording therefore claims the human, never the machine.
   */
  mine: boolean;
}

function jsonObject(v: unknown): JsonObject | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * Read the reporter of a `rolled_back` or `failed` row. `health.reportedBy`, written by the
 * automatic rollback (health.ts) and the manual one below, is authoritative, even when it
 * names no human (then the reporter is unknown, not the author). Only a row from an older
 * updater lacks it; its author is the install that first recorded the release, which is the
 * one that rolled it back unless a second install applied the same release first.
 */
export function rejectionReport(row: ReleaseRow, humanId: string | null): RejectionReport {
  const health = jsonObject(row.health);
  const reportedBy = jsonObject(health?.reportedBy);
  const human = reportedBy ? stringOrNull(reportedBy.human) : row.author_human;
  const agentRaw = reportedBy ? stringOrNull(reportedBy.agent) : row.author_agent;
  const agent = agentRaw === UPDATE_REQUEST_AUTHOR ? null : agentRaw;
  const at = stringOrNull(health?.checkedAt) ?? row.updated_at;
  return { human, agent, at, mine: human !== null && human === humanId };
}

/**
 * The refusal text for a rejected release: by whom and when, and where as far as the row
 * tells. The reporter is a human id, not an install, so the own case says "this install's
 * human" rather than "this install" (see `RejectionReport.mine`).
 */
export function previouslyRejectedMessage(
  version: string,
  status: ReleaseRow["status"],
  report: RejectionReport,
): string {
  const what = status === "failed" ? "failed its health check" : "was rolled back";
  const who = report.human
    ? `human ${report.human}`
    : report.agent
      ? `agent ${report.agent}`
      : null;
  const where = report.mine
    ? `(reported by this install's human, ${who}, on ${report.at})`
    : who
      ? `on another install (reported by ${who} on ${report.at})`
      : `on an install sharing this release table on ${report.at} (reporter not recorded)`;
  return `release ${version} ${what} ${where}; cut a new release`;
}

/**
 * U-070: an installer (the MSI, a setup `.exe`, the AppImage, a `.deb`, an `.rpm`) is not a build
 * the staged install can run. Staged and restarted into, it left the old build running; the
 * health check then rolled the release back and marked it rolled back in the release table every
 * install on the store shares, so the real release was refused everywhere. It is refused before
 * anything is downloaded, staged or recorded, and nobody is asked to approve it.
 */
export function installerRefusal(version: string, artifact: ReleaseArtifact): ForerunnerError {
  return new ForerunnerError(
    "not_supported",
    `Release ${version} for ${artifact.platform} is an installer (${artifact.name}), which the background service cannot apply as an update. Download the installer from the Updates screen and run it: it installs over this version and keeps your settings and data.`,
    {
      details: {
        reason: "installer_artifact",
        version,
        platform: artifact.platform,
        artifact: artifact.name,
      },
    },
  );
}

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
  private lastCheck: { result: UpdateCheck; at: number; installed: string } | null = null;

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

  /** Forget the cached check (after anything that changes what is installed or refused). */
  invalidateCheck(): void {
    this.lastCheck = null;
  }

  /**
   * The result of the last feed query for what is installed now, however old, without asking
   * the feed and without an audit row (the updates screen's local state). Null before the
   * first check, and again after an apply, a rollback or a refusal invalidated it.
   */
  lastCheckResult(): UpdateCheck | null {
    const cached = this.lastCheck;
    if (!cached || cached.installed !== this.installedVersion()) return null;
    return { ...cached.result, cached: true };
  }

  /**
   * Ask the feed and report the newest release this install may take. The result is reused for
   * `checkCacheMs` (the screen asks on every view) unless `fresh` is set; only a real feed
   * query appends an `update.check` audit row.
   */
  async check(
    by: UpdateActor = { kind: "system", id: null },
    opts: { fresh?: boolean } = {},
  ): Promise<UpdateCheck> {
    const channel = this.deps.config.channel;
    const current = this.installedVersion();
    const ttl = this.deps.checkCacheMs ?? DEFAULT_CHECK_CACHE_MS;
    const cached = this.lastCheck;
    if (
      !opts.fresh &&
      cached &&
      cached.installed === current &&
      this.deps.clock.now() - cached.at < ttl
    ) {
      return { ...cached.result, cached: true };
    }
    const list = await this.deps.feed.list(channel);
    const rejected: RejectedRelease[] = [];
    let available: ReleaseManifest | null = null;
    let signed: SignedManifest | null = null;
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
    const result: UpdateCheck = {
      runningVersion: current,
      channel,
      available,
      signed,
      rejected,
      checkedAt: this.now(),
      cached: false,
    };
    this.lastCheck = { result, at: this.deps.clock.now(), installed: current };
    return result;
  }

  /** Run `fn` under the install lock; a refusal is audited as `tool` when one is named. */
  private async locked<T>(
    operation: "apply" | "rollback" | "health",
    audit: { tool: string; by: UpdateActor; input: string } | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await withInstallLock(this.deps.dirs, { operation, clock: this.deps.clock }, fn);
    } catch (e) {
      if (audit && e instanceof ForerunnerError && e.details.reason === "in_progress") {
        await this.audit(audit.tool, audit.by, false, audit.input, errorMessage(e), "in_progress");
      }
      throw e;
    }
  }

  /** Download, verify and unpack into <versions>/<version>. Does not touch current.json. */
  stage(signed: SignedManifest, opts: { allowDowngrade?: boolean } = {}): Promise<StagedInstall> {
    return this.locked("apply", null, () => this.stageUnlocked(signed, opts));
  }

  private async stageUnlocked(
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
    if (isInstallerArtifact(artifact.name)) throw installerRefusal(manifest.version, artifact);
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

  /**
   * An agent needs a human's answer. The ask carries a stable `key` so the production port
   * finds the inbox row it created last time: an answered "yes" lets the retried call through,
   * "no" refuses it, and an open row is not duplicated.
   */
  private async requireApproval(
    by: UpdateActor,
    tool: "update.apply" | "update.rollback",
    key: string,
    what: string,
    why: string,
  ): Promise<void> {
    if (by.kind !== "agent") return;
    const answer = await this.deps.human.ask({
      kind: "approval",
      key,
      why: `${what}: ${why}`,
      steps: ["Open Settings > Updates", `Review the changelog and ${what}`],
      risk: "high",
      blocking: true,
      humanId: this.deps.humanId ?? null,
    });
    if (answer.outcome !== "approved") {
      await this.audit(tool, by, false, what, `not approved (${answer.outcome})`, answer.outcome);
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

  /**
   * A release that rolled back or failed is never offered or installed again. The rule reads
   * the shared release table, so a peer install's rollback counts here too; the refusal names
   * the install that reported it and when (`rejectionReport`) rather than claiming it was
   * this one.
   */
  private async assertNotRejectedBefore(m: ReleaseManifest): Promise<void> {
    const existing = await this.existingRow(m);
    if (existing && (existing.status === "rolled_back" || existing.status === "failed")) {
      const report = rejectionReport(existing, this.deps.humanId ?? null);
      throw refusal(
        "previously_rejected",
        previouslyRejectedMessage(m.version, existing.status, report),
        {
          version: m.version,
          status: existing.status,
          peer: !report.mine,
          reportedBy: { human: report.human, agent: report.agent },
          reportedAt: report.at,
        },
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
   * health check pending, audit, restart. An agent needs a human's approval first. Runs under
   * the install lock; a second apply (or a rollback, health check, prune) meanwhile is refused
   * as in_progress.
   */
  apply(opts: { by: UpdateActor; version?: string }): Promise<ApplyResult> {
    return this.locked(
      "apply",
      { tool: "update.apply", by: opts.by, input: `install ${opts.version ?? "latest"}` },
      () => this.applyLocked(opts),
    );
  }

  private async applyLocked(opts: { by: UpdateActor; version?: string }): Promise<ApplyResult> {
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
      signed = (await this.check(by, { fresh: true })).signed;
      if (!signed) throw new ForerunnerError("not_found", "no update available");
    }
    const target = signed.manifest.version;
    // Trust first, then the human: nobody is asked to approve a release that would be refused.
    try {
      this.verifyCandidate(signed);
      await this.assertNotRejectedBefore(signed.manifest);
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
    // An installer is refused before the human is asked and before anything is staged (U-070).
    const artifact = this.platform ? artifactFor(signed.manifest, this.platform) : undefined;
    if (artifact && isInstallerArtifact(artifact.name)) {
      const e = installerRefusal(target, artifact);
      await this.audit(
        "update.apply",
        by,
        false,
        `install ${target}`,
        errorMessage(e),
        "installer_artifact",
      );
      throw e;
    }
    await this.requireApproval(
      by,
      "update.apply",
      `update.apply:${target}`,
      `install update ${target}`,
      signed.manifest.notes.slice(0, 200),
    );
    let staged: StagedInstall;
    try {
      staged = await this.stageUnlocked(signed);
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
    this.invalidateCheck();
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

  /**
   * Manual rollback to the previous version named in current.json. When that version has no
   * directory (it is the packaged build) the pointer's `current` becomes null (ADR 0015).
   */
  rollback(opts: { by: UpdateActor; reason?: string }): Promise<RollbackResult> {
    return this.locked(
      "rollback",
      { tool: "update.rollback", by: opts.by, input: `roll back: ${opts.reason ?? "manual"}` },
      () => this.rollbackLocked(opts),
    );
  }

  private async rollbackLocked(opts: {
    by: UpdateActor;
    reason?: string;
  }): Promise<RollbackResult> {
    const { by } = opts;
    const pointer = readPointer(this.deps.dirs);
    if (!pointer?.current || !pointer.previous) {
      throw new ForerunnerError("not_found", "no previous version to roll back to", {
        details: { pointer },
      });
    }
    const reason = opts.reason ?? "manual rollback";
    const from = pointer.current;
    const to = pointer.previous;
    await this.requireApproval(
      by,
      "update.rollback",
      `update.rollback:${from}:${to}`,
      `roll back ${from} to ${to}`,
      reason,
    );
    const next: CurrentPointer = {
      schema: 1,
      current: rollbackCurrent(this.deps.dirs, to),
      previous: null,
      state: "installed",
      updatedAt: this.now(),
      lastRollback: { from, to, reason, at: this.now(), automatic: false },
    };
    writePointer(this.deps.dirs, next);
    this.invalidateCheck();
    const [row] = await this.deps.store.release.list(
      { release_version: from },
      { orderBy: "created_at desc", limit: 1 },
    );
    if (row && (row.status === "published" || row.status === "installed")) {
      // The row is shared with peer installs: name the reporter so their refusal can say
      // whose rollback it was (rejectionReport).
      await this.deps.store.release.setStatus(row.id, row.version, "rolled_back", {
        ok: false,
        detail: reason,
        manual: true,
        checkedAt: this.now(),
        reportedBy: {
          human: this.deps.humanId ?? (by.kind === "human" ? by.id : null),
          agent: by.kind === "agent" ? by.id : null,
        },
      });
    }
    await this.audit(
      "update.rollback",
      by,
      true,
      `roll back ${from}: ${reason}`,
      `now ${to}${next.current === null ? " (packaged build)" : ""}; restart requested`,
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

  /** The startup health check (health.ts) with this manager's wiring, under the install lock. */
  healthCheck(): Promise<HealthOutcome> {
    return this.locked("health", null, async () => {
      const outcome = await runStartupHealthCheck({
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
      if (outcome.kind !== "not_pending") this.invalidateCheck();
      return outcome;
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
    return withInstallLockSync(
      this.deps.dirs,
      { operation: "prune", clock: this.deps.clock },
      () => {
        const pointer = readPointer(this.deps.dirs);
        const keep = new Set([pointer?.current, pointer?.previous].filter((v): v is string => !!v));
        const removed: string[] = [];
        for (const name of listVersionDirs(this.deps.dirs)) {
          if (keep.has(name)) continue;
          const dir = assertInsideVersions(
            this.deps.dirs,
            join(versionsRoot(this.deps.dirs), name),
          );
          rmSync(dir, { recursive: true, force: true });
          removed.push(name);
        }
        return removed;
      },
    );
  }
}
