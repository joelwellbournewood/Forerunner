import { createHash, sign as cryptoSign } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";
import {
  type AppDirs,
  appDirs,
  join,
  relative,
  SimulatedClock,
  toPosix,
} from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import AdmZip from "adm-zip";
import type { UpdateConfig } from "../src/update/config.ts";
import { MemoryReleaseFeed, type ReleaseFeed } from "../src/update/feed.ts";
import { type HealthProbe, StaticHealthProbe } from "../src/update/health.ts";
import { UpdateManager, type UpdateManagerDeps } from "../src/update/install.ts";
import {
  type ArtifactPlatform,
  manifestBytes,
  type ReleaseManifest,
  type SignedManifest,
  type UpdateChannel,
} from "../src/update/manifest.ts";
import {
  FakeUpdateHumanPort,
  RecordingRestarter,
  type RestartRequest,
} from "../src/update/ports.ts";
import {
  generateSigningKeyPair,
  privateKeyFrom,
  type SigningKeyPair,
  signManifest,
} from "../src/update/sign.ts";
import { keyIdOf, ReleaseVerifier, sha256Hex } from "../src/update/verify.ts";

/** A zip built by adm-zip (names normalised by the library). */
export function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, text] of Object.entries(files)) zip.addFile(name, Buffer.from(text, "utf8"));
  return zip.toBuffer();
}

export interface RawZipEntry {
  name: string;
  data: Buffer;
  /** Unix mode in the high 16 bits of the external attributes (0o120777 for a symlink). */
  unixMode?: number;
}

/** A hand-built stored zip so entry names reach the reader exactly as written (zip-slip tests). */
export function rawZip(entries: RawZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((e.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, e.data);
    centrals.push(central);
    offset += local.length + e.data.length;
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

export interface FakeRelease {
  tag: string;
  signed: SignedManifest | { manifest: ReleaseManifest };
  assets: Map<string, Buffer>;
  draft: boolean;
  prerelease: boolean;
  /** When set, the manifest asset is served as this raw text instead (malformed JSON tests). */
  rawManifest?: string;
}

/**
 * Fake release server on 127.0.0.1 (node:http): the GitHub releases list shape, release
 * assets (manifest and artefacts) by download URL, and a releases.json for the JsonFeed.
 */
export class FakeReleaseServer {
  readonly releases: FakeRelease[] = [];
  readonly requests: string[] = [];
  private server: Server | null = null;
  url = "";
  manifestAssetName = "forerunner-release.json";
  /** Serve these bytes instead of the stored asset (tampering after signing). */
  readonly overrides = new Map<string, Buffer>();
  status = 200;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      this.requests.push(url.pathname);
      if (this.status !== 200) {
        res.writeHead(this.status);
        res.end();
        return;
      }
      if (url.pathname === "/repos/owner/repo/releases") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.releases.map((r, i) => this.releaseJson(r, i))));
        return;
      }
      if (url.pathname === "/releases.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            schema: 1,
            releases: this.releases.filter((r) => !r.draft && !r.rawManifest).map((r) => r.signed),
          }),
        );
        return;
      }
      const m = /^\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const rel = this.releases.find((r) => r.tag === decodeURIComponent(m[1] as string));
        const name = decodeURIComponent(m[2] as string);
        if (rel) {
          const key = `${rel.tag}/${name}`;
          const override = this.overrides.get(key);
          if (name === this.manifestAssetName) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(override ?? rel.rawManifest ?? JSON.stringify(rel.signed));
            return;
          }
          const bytes = override ?? rel.assets.get(name);
          if (bytes) {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            res.end(bytes);
            return;
          }
        }
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
    });
    await new Promise<void>((resolveStart) =>
      this.server?.listen(0, "127.0.0.1", () => resolveStart()),
    );
    const addr = this.server?.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolveStop) => this.server?.close(() => resolveStop()));
  }

  downloadUrl(tag: string, name: string): string {
    return `${this.url}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  }

  private releaseJson(r: FakeRelease, i: number): Record<string, unknown> {
    const assets = [this.manifestAssetName, ...r.assets.keys()].map((name) => ({
      name,
      size: r.assets.get(name)?.length ?? 0,
      browser_download_url: this.downloadUrl(r.tag, name),
    }));
    return {
      id: i + 1,
      tag_name: r.tag,
      name: r.tag,
      body: r.signed.manifest.notes,
      draft: r.draft,
      prerelease: r.prerelease,
      assets,
    };
  }

  add(rel: FakeRelease): FakeRelease {
    this.releases.push(rel);
    return rel;
  }
}

export interface BuildReleaseOptions {
  version: string;
  channel?: UpdateChannel;
  notes?: string;
  minSchema?: number;
  publishedAt?: string;
  /** Files of the zip artefact for every platform listed. */
  files?: Record<string, string>;
  /** Raw zip bytes instead of `files` (zip-slip tests). */
  zip?: Buffer;
  platforms?: ArtifactPlatform[];
  /** Signing key; omitted = unsigned manifest. */
  key?: SigningKeyPair | null;
  draft?: boolean;
  prerelease?: boolean;
  /** Replace the manifest after signing (tampering) without re-signing. */
  mutate?: (m: ReleaseManifest) => void;
}

/** Build a release on the server: artefact bytes, hashes, manifest, signature. */
export function buildRelease(server: FakeReleaseServer, opts: BuildReleaseOptions): FakeRelease {
  const tag = `v${opts.version}`;
  const platforms = opts.platforms ?? ["linux-x64", "windows-x64", "android"];
  const bytes = opts.zip ?? makeZip(opts.files ?? { "app/VERSION": opts.version });
  const assets = new Map<string, Buffer>();
  const artifacts = platforms.map((platform) => {
    const name = `forerunner-${opts.version}-${platform}.zip`;
    assets.set(name, bytes);
    return {
      platform,
      name,
      url: server.downloadUrl(tag, name),
      sha256: sha256Hex(bytes),
      size: bytes.length,
    };
  });
  const manifest: ReleaseManifest = {
    schema: 1,
    version: opts.version,
    channel: opts.channel ?? "stable",
    publishedAt: opts.publishedAt ?? "2026-10-20T10:00:00.000Z",
    notes: opts.notes ?? `Release ${opts.version}`,
    minSchema: opts.minSchema ?? 1,
    artifacts,
  };
  const signed: SignedManifest | { manifest: ReleaseManifest } =
    opts.key === null ? { manifest } : signManifest(manifest, (opts.key ?? testKey()).privateKey);
  if (opts.mutate) opts.mutate(signed.manifest);
  return server.add({
    tag,
    signed,
    assets,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
  });
}

/**
 * Sign a manifest-shaped object without the schema check `signManifest` performs: what a
 * hand-edited or foreign release workflow could publish (a version with build metadata, a
 * leading "v"). The signature is valid; only the installer's rules decide what happens.
 */
export function signRaw(manifest: Record<string, unknown>, key: SigningKeyPair = testKey()) {
  const { key: priv, publicKeyRaw } = privateKeyFrom(key.privateKey);
  const sig = cryptoSign(null, manifestBytes(manifest as unknown as ReleaseManifest), priv);
  return {
    manifest: manifest as unknown as ReleaseManifest,
    signature: {
      alg: "ed25519" as const,
      keyId: keyIdOf(publicKeyRaw),
      signature: Buffer.from(sig).toString("base64"),
    },
  } satisfies SignedManifest;
}

let cachedKey: SigningKeyPair | null = null;
/** One test signing key per process (generated, never stored). */
export function testKey(): SigningKeyPair {
  cachedKey ??= generateSigningKeyPair();
  return cachedKey;
}

/**
 * Stands in for the shell: records every restart request and, when `boots` is true, "relaunches"
 * into the target version so the running version matches current.json (a build that crashes on
 * start is simulated with boots = false: the shell falls back to the old build).
 */
export class BootingRestarter extends RecordingRestarter {
  boots = true;
  constructor(readonly running: { version: string }) {
    super();
  }
  override async restart(req: RestartRequest): Promise<void> {
    await super.restart(req);
    if (this.boots) this.running.version = req.targetVersion;
  }
}

export interface Harness {
  home: string;
  dirs: AppDirs;
  clock: SimulatedClock;
  store: StateStore;
  human: FakeUpdateHumanPort;
  restarter: BootingRestarter;
  running: { version: string };
  probe: StaticHealthProbe;
  feed: ReleaseFeed;
  config: Pick<UpdateConfig, "channel" | "allowDowngrade" | "healthTimeoutMs">;
  manager: UpdateManager;
  deps: UpdateManagerDeps;
  close(): Promise<void>;
}

export interface HarnessOptions {
  feed?: ReleaseFeed;
  runningVersion?: string;
  localSchemaVersion?: number;
  allowDowngrade?: boolean;
  healthTimeoutMs?: number;
  probe?: HealthProbe;
  trustedKeys?: SigningKeyPair[];
  platform?: ArtifactPlatform;
  channel?: UpdateChannel;
  /** Default 0: every check() in a test asks the feed unless the test is about the cache. */
  checkCacheMs?: number;
}

/** Seed config, memory and data files that an update must never touch. */
export function seedProtectedFiles(dirs: AppDirs): void {
  mkdirSync(dirs.config, { recursive: true });
  mkdirSync(join(dirs.data, "memory", "alice"), { recursive: true });
  writeFileSync(
    join(dirs.config, "config.json"),
    JSON.stringify({ version: 1, profile: "default" }),
  );
  writeFileSync(join(dirs.config, "update.json"), JSON.stringify({ channel: "stable" }));
  writeFileSync(
    join(dirs.data, "memory", "alice", "lessons.md"),
    "# lessons\n- keep tests green\n",
  );
  writeFileSync(join(dirs.data, "state.sqlite"), Buffer.from("not a real database but mine"));
  writeFileSync(join(dirs.data, "audit.log"), "line 1\n");
}

/** Hash of every file under `dir` (relative posix path + bytes), skipping `skip` top-level names. */
export function hashTree(dir: string, skip: string[] = []): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (d === dir && skip.includes(name)) continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        h.update(`symlink:${toPosix(relative(dir, p))}\n`);
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      h.update(`${toPosix(relative(dir, p))}\n`);
      h.update(readFileSync(p));
      h.update("\n");
    }
  };
  walk(dir);
  return h.digest("hex");
}

export function protectedHashes(dirs: AppDirs): { config: string; memory: string; data: string } {
  return {
    config: hashTree(dirs.config),
    memory: hashTree(join(dirs.data, "memory")),
    data: hashTree(dirs.data, ["versions"]),
  };
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "fr-update-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  seedProtectedFiles(dirs);
  const clock = new SimulatedClock("2026-10-20T12:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = new FakeUpdateHumanPort("approved");
  const running = { version: opts.runningVersion ?? "1.0.0" };
  const restarter = new BootingRestarter(running);
  const probe =
    (opts.probe as StaticHealthProbe | undefined) ??
    new StaticHealthProbe({ ok: true, detail: "fake daemon healthy" });
  const feed = opts.feed ?? new MemoryReleaseFeed([]);
  const config = {
    channel: opts.channel ?? ("stable" as const),
    allowDowngrade: opts.allowDowngrade ?? false,
    healthTimeoutMs: opts.healthTimeoutMs ?? 60_000,
  };
  const deps: UpdateManagerDeps = {
    dirs,
    clock,
    feed,
    verifier: new ReleaseVerifier(
      (opts.trustedKeys ?? [testKey()]).map((k) => ({ id: k.keyId, publicKey: k.publicKey })),
    ),
    store: { release: store.release, auditLog: store.auditLog },
    human,
    restarter,
    probe: opts.probe ?? probe,
    config,
    runningVersion: () => running.version,
    localSchemaVersion: opts.localSchemaVersion ?? 1,
    platform: opts.platform ?? "linux-x64",
    humanId: "human-j",
    checkCacheMs: opts.checkCacheMs ?? 0,
  };
  const manager = new UpdateManager(deps);
  return {
    home,
    dirs,
    clock,
    store,
    human,
    restarter,
    running,
    probe,
    feed,
    config,
    manager,
    deps,
    close: () => store.close(),
  };
}
