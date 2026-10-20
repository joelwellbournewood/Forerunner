import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  appDirs,
  basename,
  type Clock,
  dirname,
  ForerunnerError,
  isAbsolute,
  isInside,
  join,
  log,
  newId,
  normalize,
  resolve,
  safeSegment,
  systemClock,
} from "@forerunner/platform";
import type {
  AuditLogRepo,
  DataAssetRepo,
  DataAssetRow,
  JsonValue,
  ProjectRepo,
} from "@forerunner/state";
import {
  describeFile,
  describeFolder,
  describeRemote,
  detectEncoding,
  folderSample,
  formatFromExtension,
  mimeFor,
  parseUri,
  readHead,
  sampleFile,
  type TextEncodingName,
} from "./metadata.ts";
import {
  DATA_ASSET_KINDS,
  type DataActor,
  type DataAssetKind,
  type DataAssetView,
  type DataLimits,
  type DataSample,
  type DataStorage,
  largeDataNote,
  REMOTE_SCHEMES,
  resolveDataLimits,
  StoredAssetInfo,
} from "./types.ts";
import { walkFolder } from "./walk.ts";

/**
 * Data assets of a project (spec L "Files and data"): files, folders and datasets registered
 * by path or URI, copied into the project data dir or linked where they sit. Agents reach them
 * only through `describe()` and `sample()`, both capped; `remove()` needs a human.
 *
 * Layout: `<projectsRoot>/<project id>/data/<asset id>-<name>` for copies and uploads,
 * `<projectsRoot>/<project id>/data/imports/<name>-<suffix>/` for ZIP and folder imports.
 * `projectsRoot` defaults to `appDirs().data/projects`.
 */
export interface DataAssetsStore {
  dataAsset: DataAssetRepo;
  project: ProjectRepo;
  auditLog: AuditLogRepo;
}

export interface DataAssetsOptions {
  store: DataAssetsStore;
  clock?: Clock;
  /** Root of the per-project directories. Default `appDirs().data/projects`. */
  projectsRoot?: string;
  limits?: Partial<DataLimits>;
}

export type RegisterMode = "copy" | "link";

export interface RegisterInput {
  projectId: string;
  /** Absolute local path, or a URI (s3://, r2://, gs://, az://, hf://, https://, http://). */
  source: string;
  /** Default: folder for a directory, file otherwise. */
  kind?: DataAssetKind;
  /** Copy into the project data dir (small sources only) or link in place (default). */
  mode?: RegisterMode;
  /** Display name; default the last path segment. */
  name?: string;
  /** Size of a remote dataset when the caller knows it (never read over the network). */
  sizeBytes?: number;
}

export interface UploadInput {
  projectId: string;
  name: string;
  bytes: Uint8Array;
  kind?: DataAssetKind;
}

export interface SampleOptions {
  rows?: number;
  bytes?: number;
}

/** The UI's kinds (folder, csv, parquet, sqlite, zip, dataset, other) onto the structural kinds. */
export function normalizeKind(kind: string | undefined | null): DataAssetKind | undefined {
  if (!kind) return undefined;
  if ((DATA_ASSET_KINDS as readonly string[]).includes(kind)) return kind as DataAssetKind;
  return "file";
}

export function isRemoteSource(source: string): boolean {
  return parseUri(source) !== null;
}

export class DataAssets {
  readonly limits: DataLimits;
  readonly projectsRoot: string;
  private readonly store: DataAssetsStore;
  private readonly clock: Clock;
  private readonly logger = log("data:assets");

  constructor(opts: DataAssetsOptions) {
    this.store = opts.store;
    this.clock = opts.clock ?? systemClock;
    this.limits = resolveDataLimits(opts.limits);
    this.projectsRoot = resolve(opts.projectsRoot ?? join(appDirs().data, "projects"));
  }

  /** `<projectsRoot>/<project id>/data`; created on demand. */
  projectDataDir(projectId: string): string {
    return join(this.projectsRoot, safeSegment(projectId, "project"), "data");
  }

  // -------------------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------------------

  async register(
    input: RegisterInput,
    actor: DataActor,
    opts: { audit?: boolean } = {},
  ): Promise<DataAssetView> {
    const projectId = input.projectId;
    if (!(await this.store.project.exists(projectId))) {
      throw new ForerunnerError("not_found", `project ${projectId} not found`, {
        details: { projectId },
      });
    }
    const source = input.source.trim();
    if (!source) throw new ForerunnerError("validation", "source must not be empty");
    if (input.kind !== undefined && !(DATA_ASSET_KINDS as readonly string[]).includes(input.kind)) {
      throw new ForerunnerError("validation", `kind must be one of ${DATA_ASSET_KINDS.join(", ")}`);
    }
    const uri = parseUri(source);
    const prepared = uri
      ? this.prepareRemote(source, uri, input)
      : await this.prepareLocal(projectId, source, input);
    const id = prepared.id;
    const row = await this.store.dataAsset.insert({
      id,
      project_ids: [projectId],
      locator: prepared.locator,
      size_bytes: prepared.sizeBytes,
      owner_device_id: actor.deviceId ?? null,
      kind: prepared.kind,
      sample: prepared.info as unknown as JsonValue,
      registered_by: registeredBy(actor),
      author_human: actor.humanId ?? null,
      author_agent: actor.agentId ?? null,
    });
    await this.linkToProject(projectId, id, "add");
    if (opts.audit !== false) {
      await this.audit(
        actor,
        "data.register",
        `${prepared.kind} ${prepared.info.storage} ${prepared.info.name}`,
        id,
      );
    }
    this.logger.info("registered", {
      id,
      projectId,
      kind: prepared.kind,
      storage: prepared.info.storage,
      sizeBytes: prepared.sizeBytes,
    });
    return this.view(row);
  }

  /** Bytes received over the daemon API land in the project data dir, then register as a copy. */
  async registerUpload(input: UploadInput, actor: DataActor): Promise<DataAssetView> {
    if (input.bytes.byteLength > this.limits.uploadMaxBytes) {
      throw new ForerunnerError(
        "validation",
        `upload of ${input.bytes.byteLength} bytes exceeds the cap of ${this.limits.uploadMaxBytes}; register large data by path or URI instead`,
        { details: { tooLarge: true, maxBytes: this.limits.uploadMaxBytes } },
      );
    }
    if (!(await this.store.project.exists(input.projectId))) {
      throw new ForerunnerError("not_found", `project ${input.projectId} not found`);
    }
    const dir = this.projectDataDir(input.projectId);
    mkdirSync(dir, { recursive: true });
    const id = newId(this.clock.now());
    const name = safeFileName(input.name);
    const dest = join(dir, `${id}-${name}`);
    writeFileSync(dest, input.bytes, { mode: 0o600 });
    try {
      return await this.register(
        {
          projectId: input.projectId,
          source: dest,
          kind: input.kind ?? "file",
          mode: "link",
          name,
        },
        actor,
        { audit: false },
      ).then(async (view) => {
        await this.audit(actor, "data.upload", `${name} (${input.bytes.byteLength} B)`, view.id);
        return view;
      });
    } catch (e) {
      rmSync(dest, { force: true });
      throw e;
    }
  }

  private prepareRemote(
    source: string,
    uri: { scheme: string; host: string; name: string },
    input: RegisterInput,
  ): Prepared {
    if (!(REMOTE_SCHEMES as readonly string[]).includes(uri.scheme)) {
      throw new ForerunnerError(
        "validation",
        `unsupported URI scheme ${uri.scheme}://; use one of ${REMOTE_SCHEMES.map((s) => `${s}://`).join(", ")}`,
        { details: { scheme: uri.scheme } },
      );
    }
    if (input.mode === "copy") {
      throw new ForerunnerError(
        "not_supported",
        "a remote dataset is registered where it sits; the runtime never copies it. Keep it in R2 or S3 and read it from there.",
      );
    }
    const kind = input.kind ?? "dataset";
    const name = input.name?.trim() || uri.name;
    const sizeBytes = Math.max(0, Math.floor(input.sizeBytes ?? 0));
    return {
      id: newId(this.clock.now()),
      locator: source,
      kind,
      sizeBytes,
      info: {
        v: 1,
        name,
        storage: "remote",
        format: formatFromExtension(name) ?? "remote",
        mime: mimeFor(formatFromExtension(name) ?? "remote", name),
        note:
          "Registered by URI. The runtime never fetches it: agents see this description only. " +
          "Large data stays at its origin (R2, S3, GCS) or in Git LFS; it never goes into git.",
        metadata: describeRemote(uri),
        sample: null,
      },
    };
  }

  private async prepareLocal(
    projectId: string,
    source: string,
    input: RegisterInput,
  ): Promise<Prepared> {
    if (!isAbsolute(source)) {
      throw new ForerunnerError(
        "validation",
        `source must be an absolute path or a URI: ${source}`,
      );
    }
    const abs = normalize(resolve(source));
    let st: ReturnType<typeof statSync>;
    try {
      st = lstatSync(abs);
    } catch {
      throw new ForerunnerError("not_found", `no file or folder at ${abs}`, {
        details: { source: abs },
      });
    }
    if (st.isSymbolicLink()) {
      throw new ForerunnerError("validation", `symlinks are never registered: ${abs}`);
    }
    const isDir = st.isDirectory();
    if (!isDir && !st.isFile()) {
      throw new ForerunnerError("validation", `not a regular file or folder: ${abs}`);
    }
    const kind: DataAssetKind = input.kind ?? (isDir ? "folder" : "file");
    if (kind === "folder" && !isDir)
      throw new ForerunnerError("validation", `kind folder but ${abs} is a file`);
    if (kind === "file" && isDir)
      throw new ForerunnerError("validation", `kind file but ${abs} is a folder`);
    const name = input.name?.trim() || basename(abs);
    const dataDir = this.projectDataDir(projectId);
    const alreadyInside = isInside(dataDir, abs);
    const id = newId(this.clock.now());

    if (isDir) {
      const { walk, metadata, storedSample } = describeFolder(abs, this.limits);
      const sizeBytes = walk.totalBytes;
      const large = walk.truncated || sizeBytes > this.limits.copyThresholdBytes;
      let locator = abs;
      let storage: DataStorage = alreadyInside ? "copied" : "linked";
      let note: string | null = null;
      if (large) {
        note = largeDataNote(sizeBytes, this.limits.copyThresholdBytes);
        if (walk.truncated) note += ` The folder walk stopped at the ${walk.limit} limit.`;
      } else if (input.mode === "copy" && !alreadyInside) {
        mkdirSync(dataDir, { recursive: true });
        locator = join(dataDir, `${id}-${safeFileName(name)}`);
        for (const f of walk.files) {
          const dest = join(locator, ...f.rel.split("/"));
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(f.path, dest);
        }
        storage = "copied";
      }
      return {
        id,
        locator,
        kind,
        sizeBytes,
        info: {
          v: 1,
          name,
          storage,
          format: "folder",
          mime: metadata.mime,
          note,
          metadata,
          sample: storedSample,
        },
      };
    }

    const sizeBytes = st.size;
    const described = await describeFile(abs, sizeBytes, this.limits);
    const large = sizeBytes > this.limits.copyThresholdBytes;
    let locator = abs;
    let storage: DataStorage = alreadyInside ? "copied" : "linked";
    let note: string | null = null;
    if (large) {
      note = largeDataNote(sizeBytes, this.limits.copyThresholdBytes);
    } else if (input.mode === "copy" && !alreadyInside) {
      mkdirSync(dataDir, { recursive: true });
      locator = join(dataDir, `${id}-${safeFileName(name)}`);
      copyFileSync(abs, locator);
      storage = "copied";
    }
    return {
      id,
      locator,
      kind,
      sizeBytes,
      info: {
        v: 1,
        name,
        storage,
        format: described.format,
        mime: described.mime,
        note,
        metadata: described.metadata,
        sample: described.storedSample,
      },
    };
  }

  // -------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------

  async list(projectId: string): Promise<DataAssetView[]> {
    const rows = await this.store.dataAsset.forProject(projectId);
    return rows.map((r) => this.view(r));
  }

  async get(id: string): Promise<DataAssetView> {
    return this.view(await this.store.dataAsset.mustGet(id));
  }

  /** Metadata and the stored sample; never touches the bytes. */
  describe(id: string): Promise<DataAssetView> {
    return this.get(id);
  }

  /**
   * First N rows or first N bytes, capped at `limits.sampleBytes` whatever the caller asks.
   * Remote assets return their stored sample (the runtime never fetches).
   */
  async sample(id: string, opts: SampleOptions = {}): Promise<DataSample> {
    const row = await this.store.dataAsset.mustGet(id);
    const view = this.view(row);
    const cap = Math.min(
      Math.max(1, Math.floor(opts.bytes ?? this.limits.sampleBytes)),
      this.limits.sampleBytes,
    );
    const rows = Math.min(
      Math.max(1, Math.floor(opts.rows ?? this.limits.sampleRows)),
      this.limits.maxSampleRows,
    );
    if (view.storage === "remote") {
      return (
        view.sample ?? {
          kind: "none",
          bytes: 0,
          capBytes: cap,
          truncated: true,
          note: "remote dataset: the runtime never fetches it; read it from its origin in a run",
        }
      );
    }
    if (!view.available) {
      throw new ForerunnerError("not_found", `${view.name} is no longer at ${view.locator}`, {
        details: { id, locator: view.locator },
      });
    }
    const st = statSync(view.locator);
    if (st.isDirectory()) {
      const walk = walkFolder(view.locator, {
        maxEntries: Math.min(this.limits.maxEntries, rows * 10),
        maxTotalBytes: this.limits.maxTotalBytes,
        maxDepth: this.limits.maxDepth,
      });
      return folderSample(walk, rows, cap);
    }
    const encoding =
      (view.metadata?.encoding as TextEncodingName | null) ??
      detectEncoding(readHead(view.locator, 512));
    return sampleFile(
      view.locator,
      st.size,
      view.format,
      encoding,
      view.metadata?.delimiter ?? null,
      { rows, bytes: cap },
      this.limits,
    );
  }

  // -------------------------------------------------------------------------------------
  // Removal: a human, always (spec S.6 "deleting data")
  // -------------------------------------------------------------------------------------

  async remove(id: string, actor: DataActor): Promise<{ id: string; deletedFromDisk: boolean }> {
    if (!actor.humanId) {
      throw new ForerunnerError("approval_required", "removing a data asset needs a human", {
        details: { id },
      });
    }
    const row = await this.store.dataAsset.mustGet(id);
    const view = this.view(row);
    let deletedFromDisk = false;
    if (view.storage === "copied") {
      const inside = row.project_ids.some((p) => isInside(this.projectDataDir(p), view.locator));
      if (inside && existsSync(view.locator)) {
        rmSync(view.locator, { recursive: true, force: true });
        deletedFromDisk = true;
      }
    }
    await this.store.dataAsset.delete(id);
    for (const p of row.project_ids) await this.linkToProject(p, id, "remove");
    await this.audit(
      actor,
      "data.remove",
      `${view.kind} ${view.storage} ${view.name}`,
      deletedFromDisk ? "copy deleted" : "registration removed; original untouched",
    );
    return { id, deletedFromDisk };
  }

  // -------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------

  view(row: DataAssetRow): DataAssetView {
    const parsed = StoredAssetInfo.safeParse(row.sample);
    const remote = isRemoteSource(row.locator);
    const fallbackName = (basename(row.locator) || row.locator).replace(/^[0-9a-f-]{36}-/, "");
    const info: StoredAssetInfo = parsed.success
      ? parsed.data
      : {
          v: 1,
          name: fallbackName,
          storage: remote ? "remote" : "linked",
          format: formatFromExtension(fallbackName) ?? (remote ? "remote" : "binary"),
          mime: mimeFor(formatFromExtension(fallbackName) ?? "binary", fallbackName),
          note: null,
          metadata: null,
          sample: null,
        };
    return {
      id: row.id,
      projectIds: row.project_ids,
      locator: row.locator,
      name: info.name,
      sizeBytes: row.size_bytes,
      kind: row.kind,
      ownerDeviceId: row.owner_device_id,
      sample: info.sample,
      registeredBy: row.registered_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      storage: info.storage,
      format: info.format,
      mime: info.mime,
      metadata: info.metadata,
      note: info.note,
      available: info.storage === "remote" ? true : existsSync(row.locator),
    };
  }

  // -------------------------------------------------------------------------------------

  private async linkToProject(
    projectId: string,
    assetId: string,
    op: "add" | "remove",
  ): Promise<void> {
    const project = await this.store.project.get(projectId);
    if (!project) return;
    const current = Array.isArray(project.data_assets) ? project.data_assets : [];
    const next =
      op === "add" ? [...new Set([...current, assetId])] : current.filter((x) => x !== assetId);
    if (next.length === current.length && op === "add" && current.includes(assetId)) return;
    await this.store.project.patch(projectId, { data_assets: next });
  }

  private async audit(
    actor: DataActor,
    tool: string,
    inputSummary: string,
    resultSummary: string,
  ): Promise<void> {
    await this.store.auditLog.append({
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

interface Prepared {
  id: string;
  locator: string;
  kind: DataAssetKind;
  sizeBytes: number;
  info: StoredAssetInfo;
}

function registeredBy(actor: DataActor): string {
  return actor.agentId ?? actor.humanId ?? actor.deviceId ?? "runtime";
}

/** One safe file name for every OS: no separators, no control characters, no reserved names. */
export function safeFileName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")) || "file";
  const cleaned = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we strip
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned))
    return `_${cleaned || "file"}`;
  return cleaned;
}
