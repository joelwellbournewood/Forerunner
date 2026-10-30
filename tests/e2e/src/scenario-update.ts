/**
 * Signed updates on the scenario world (spec M; ADR 0015; scenario 7 "Bad update"): the
 * release workflow's half (a zip artefact per platform, the signed manifest, both uploaded as
 * assets of a release on the fake git host, exactly as the publish job does) and the install's
 * half (the production `UpdateManager` over the world's store with the GitHub releases feed
 * against the fake host, the release verifier with the build's trusted key, the production
 * `HumanRequestUpdatePort` that writes inbox rows, a restarter that stands in for the shell and
 * "boots" the version `current.json` names, and a health probe that runs the staged build's
 * own doctor script through the real `DoctorHealthProbe`). The rollback rule, the pointer
 * write, the release row and the audit rows are the production code paths.
 *
 * Two clocks meet in the health probe. `UpdateManager` arms its `healthTimeoutMs` on the
 * world's `SimulatedClock`, so a doctor that hangs is timed out only when a scenario advances
 * the clock while the check is pending (scenario 7's second case does exactly that and
 * asserts the "timed out" rollback). The doctor itself is a real child process, so
 * `StagedDoctorProbe` also bounds it on the wall clock (`wallTimeoutMs`, 20 s by default):
 * a scenario that forgets to advance the clock gets a failed health result and a rollback,
 * never a hang until vitest's limit. The wall bound is the helper's guard, not a production
 * rule; the updater's own timeout is the simulated one.
 *
 * The zip is built here without a dependency (stored entries, CRC-32 from node:zlib): the
 * e2e package declares no archive library and never installs one for a test.
 */
import { existsSync, mkdirSync } from "node:fs";
import { crc32 } from "node:zlib";
import { type AppDirs, appDirs, join } from "@forerunner/platform";
import { type NotificationRecord, updates } from "@forerunner/runtime";
import { MIGRATIONS } from "@forerunner/state";
import { type ScenarioNotifier, scenarioNotifier } from "./scenario-notify.ts";
import type { Install, ScenarioWorld } from "./scenario-world.ts";

// ---------------------------------------------------------------------------------------
// Artefacts

/** A stored (uncompressed) zip of text files; entry names are POSIX paths. */
export function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** The doctor script of a build: `fr doctor --json` as the health probe runs it. */
export const DOCTOR_SCRIPT = "app/doctor.mjs";

/** A build whose doctor reports every check ok and exits 0. */
export function healthyDoctor(version: string): string {
  return [
    `const checks = [`,
    `  { name: "daemon", ok: true, detail: "daemon ${version} answers on the loopback" },`,
    `  { name: "state", ok: true, detail: "schema current" },`,
    `];`,
    `process.stdout.write(JSON.stringify(checks));`,
    "",
  ].join("\n");
}

/**
 * A build that cannot start: its doctor fails with the reason on stderr and a non-zero exit,
 * which the probe turns into a failed health result with that reason.
 */
export function brokenDoctor(reason: string): string {
  return [`process.stderr.write(${JSON.stringify(reason)});`, `process.exitCode = 1;`, ""].join(
    "\n",
  );
}

/**
 * A build whose doctor never answers: it keeps the event loop alive and prints nothing, so
 * only the updater's health timeout (or the probe's wall bound) ends the check; the abort
 * kills the process.
 */
export function hangingDoctor(): string {
  return ["setInterval(() => {}, 1_000);", ""].join("\n");
}

// ---------------------------------------------------------------------------------------
// The release feed on the fake git host

export interface ReleaseFeedOnHost {
  owner: string;
  repo: string;
  /** Token of the release workflow (the publish job's), by value only inside this process. */
  token: string;
  feed: updates.UpdateFeedConfig;
  /** The build's signing key: the public half is the install's trusted key. */
  key: updates.SigningKeyPair;
  api(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  publish(input: PublishInput): Promise<PublishedRelease>;
}

export interface PublishInput {
  version: string;
  /** Files of the zip artefact, the same for every platform. */
  files: Record<string, string>;
  notes?: string;
  channel?: updates.UpdateChannel;
  minSchema?: number;
  platforms?: updates.ArtifactPlatform[];
}

export interface PublishedRelease {
  version: string;
  tag: string;
  releaseId: number;
  zip: Buffer;
  manifest: updates.ReleaseManifest;
  signed: updates.SignedManifest;
}

/**
 * A repository for the app's releases on the world's fake git host, owned by the install's
 * human (the registry owner is a configuration, never a constant), with the publish job's
 * steps as a function: create the release, upload one artefact per platform, upload the
 * signed manifest as the `forerunner-release.json` asset.
 */
export async function releaseFeedOnHost(
  world: ScenarioWorld,
  install: Install,
  opts: { repo?: string } = {},
): Promise<ReleaseFeedOnHost> {
  const owner = install.human.login;
  const repo = opts.repo ?? "forerunner-app";
  await world.gitHost.createRepo({
    owner,
    name: repo,
    private: false,
    initialFiles: { "README.md": `# ${repo}\n\nReleases of the app.\n` },
  });
  const token = world.gitHost.createToken({ owner, kind: "classic", scopes: ["repo"] }).token;
  const key = updates.generateSigningKeyPair();
  const api = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${world.gitHost.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && !(body instanceof Uint8Array)
          ? { "content-type": "application/json" }
          : {}),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Uint8Array
            ? new Uint8Array(body)
            : JSON.stringify(body),
    });
  const publish = async (input: PublishInput): Promise<PublishedRelease> => {
    const tag = `v${input.version}`;
    const created = await api("POST", `/repos/${owner}/${repo}/releases`, {
      tag_name: tag,
      name: tag,
      body: input.notes ?? `Release ${input.version}`,
    });
    if (created.status !== 201) throw new Error(`release not created: ${created.status}`);
    const releaseId = ((await created.json()) as { id: number }).id;
    const zip = storedZip(input.files);
    const platforms = input.platforms ?? ["windows-x64", "linux-x64", "android"];
    const artifacts: updates.ReleaseArtifact[] = [];
    for (const platform of platforms) {
      const name = `forerunner-${input.version}-${platform}.zip`;
      const upload = await api(
        "POST",
        `/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        zip,
        { "content-type": "application/zip" },
      );
      if (upload.status !== 201) throw new Error(`artefact not uploaded: ${upload.status}`);
      const uploaded = (await upload.json()) as { browser_download_url: string };
      artifacts.push({
        platform,
        name,
        url: uploaded.browser_download_url,
        sha256: updates.sha256Hex(zip),
        size: zip.length,
      });
    }
    const manifest: updates.ReleaseManifest = {
      schema: 1,
      version: input.version,
      channel: input.channel ?? "stable",
      publishedAt: world.clock.nowIso(),
      notes: input.notes ?? `## ${input.version}\n- release ${input.version}`,
      minSchema: input.minSchema ?? 1,
      artifacts,
    };
    const signed = updates.signManifest(manifest, key.privateKey);
    const manifestUpload = await api(
      "POST",
      `/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${updates.DEFAULT_MANIFEST_ASSET_NAME}`,
      Buffer.from(JSON.stringify(signed), "utf8"),
      { "content-type": "application/json" },
    );
    if (manifestUpload.status !== 201)
      throw new Error(`manifest not uploaded: ${manifestUpload.status}`);
    return { version: input.version, tag, releaseId, zip, manifest, signed };
  };
  return {
    owner,
    repo,
    token,
    feed: { kind: "github", owner, repo, apiBase: world.gitHost.baseUrl },
    key,
    api,
    publish,
  };
}

// ---------------------------------------------------------------------------------------
// The install's updater

/** Default wall bound on one doctor run (real milliseconds). */
export const DEFAULT_DOCTOR_WALL_TIMEOUT_MS = 20_000;

/**
 * The health probe of this install: the staged build's own doctor (`app/doctor.mjs` under the
 * version directory `current.json` names), run through the real `DoctorHealthProbe` with an
 * argv array (no shell). A build without a doctor is unhealthy.
 *
 * The updater's `healthTimeoutMs` runs on the simulated clock (see the module header); the
 * doctor is a real process, so each run is also bounded by `wallTimeoutMs` of real time. When
 * the updater's abort arrives first the doctor's own (late) result is still recorded in
 * `results`, so a scenario can assert the child was killed rather than leaked.
 */
export class StagedDoctorProbe implements updates.HealthProbe {
  readonly name = "doctor";
  readonly checks: updates.HealthProbeContext[] = [];
  /** What every doctor run ended with, once it ended (after an abort, the kill's result). */
  readonly results: Array<{ version: string; result: updates.HealthResult }> = [];
  private readonly wallTimeoutMs: number;
  constructor(
    private readonly dirs: AppDirs,
    opts: { wallTimeoutMs?: number } = {},
  ) {
    this.wallTimeoutMs = opts.wallTimeoutMs ?? DEFAULT_DOCTOR_WALL_TIMEOUT_MS;
  }
  async check(ctx: updates.HealthProbeContext): Promise<updates.HealthResult> {
    this.checks.push(ctx);
    const script = join(updates.versionDir(this.dirs, ctx.version), ...DOCTOR_SCRIPT.split("/"));
    if (!existsSync(script)) {
      return { ok: false, detail: `the staged build ${ctx.version} has no ${DOCTOR_SCRIPT}` };
    }
    const wall = AbortSignal.timeout(this.wallTimeoutMs);
    const doctor = new updates.DoctorHealthProbe({ argv: [process.execPath, script, "--json"] });
    const result = await doctor.check({ ...ctx, signal: AbortSignal.any([ctx.signal, wall]) });
    const settled: updates.HealthResult =
      wall.aborted && !ctx.signal.aborted
        ? {
            ok: false,
            detail: `doctor did not finish within ${this.wallTimeoutMs} ms of wall time (${result.detail})`,
          }
        : result;
    this.results.push({ version: ctx.version, result: settled });
    return settled;
  }
}

/**
 * Stands in for the desktop shell's "Update and restart": records every request, relaunches
 * into the version named by the request (so the running version matches `current.json` on
 * the next start) and raises the `update_applied` notification the daemon raises on a restart
 * request (compose.ts, `events.on("restart")`).
 */
export class ScenarioRestarter implements updates.Restarter {
  readonly requests: updates.RestartRequest[] = [];
  constructor(
    readonly running: { version: string },
    private readonly notify: ScenarioNotifier,
    private readonly humanId: string,
  ) {}
  async restart(req: updates.RestartRequest): Promise<void> {
    this.requests.push(req);
    this.running.version = req.targetVersion;
    // As compose.ts: the setup assistant's restart is no update and raises no notice.
    if (req.reason === "setup") return;
    await this.notify.producers.updateApplied(this.humanId, {
      reason: req.reason,
      targetVersion: req.targetVersion,
      fromVersion: req.fromVersion,
    });
  }
}

export interface ScenarioUpdater {
  home: string;
  dirs: AppDirs;
  manager: updates.UpdateManager;
  running: { version: string };
  restarter: ScenarioRestarter;
  probe: StagedDoctorProbe;
  notify: ScenarioNotifier;
  /** Notifications that reached the human, newest first. */
  notifications(): NotificationRecord[];
  /** The pointer file as it stands. */
  pointer(): updates.CurrentPointer | null;
}

export interface ScenarioUpdaterOptions {
  /** Version of the packaged build this install runs at start (no directory under versions/). */
  runningVersion: string;
  /** The updater's health timeout, in simulated ms (default 30 s). */
  healthTimeoutMs?: number;
  /** The probe's bound on one doctor run, in real ms (default 20 s). */
  doctorWallTimeoutMs?: number;
}

/**
 * The artefact platform of this machine (windows-x64, linux-x64, android); a machine the
 * release has no artefact for (another architecture) takes the linux-x64 artefact, which is
 * the same zip in this scenario.
 */
export function artifactPlatform(): updates.ArtifactPlatform {
  try {
    return updates.detectArtifactPlatform();
  } catch {
    return "linux-x64";
  }
}

/** The install's updater over the world's store, its own home under the world's temp root. */
export function scenarioUpdater(
  world: ScenarioWorld,
  install: Install,
  feed: ReleaseFeedOnHost,
  opts: ScenarioUpdaterOptions,
): ScenarioUpdater {
  const home = join(world.root, `home-${install.name.toLowerCase()}`);
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const running = { version: opts.runningVersion };
  const notify = scenarioNotifier(world);
  const restarter = new ScenarioRestarter(running, notify, install.human.id);
  const probe = new StagedDoctorProbe(dirs, { wallTimeoutMs: opts.doctorWallTimeoutMs });
  const config: updates.UpdateConfig = updates.UpdateConfig.parse({
    channel: "stable",
    feed: feed.feed,
    trustedKeys: [{ id: feed.key.keyId, publicKey: feed.key.publicKey }],
    allowDowngrade: false,
    healthTimeoutMs: opts.healthTimeoutMs ?? 30_000,
  });
  const manager = new updates.UpdateManager({
    dirs,
    clock: world.clock,
    feed: updates.feedFromConfig(config.feed),
    verifier: new updates.ReleaseVerifier(config.trustedKeys),
    store: { release: world.store.release, auditLog: world.store.auditLog },
    human: new updates.HumanRequestUpdatePort(world.store.humanRequest, install.human.id),
    restarter,
    probe,
    config,
    runningVersion: () => running.version,
    localSchemaVersion: world.store.migration?.version ?? MIGRATIONS.length,
    platform: artifactPlatform(),
    humanId: install.human.id,
    checkCacheMs: 0,
  });
  return {
    home,
    dirs,
    manager,
    running,
    restarter,
    probe,
    notify,
    notifications: () => notify.recent(install.human.id),
    pointer: () => updates.readPointer(dirs),
  };
}
