import { z } from "zod";

/**
 * Shared shapes of the data module (spec L "Files and data", K Project page "Data" tab, A.3
 * ZIP and folder import). Agents see metadata and samples, never whole files; the caps below
 * are enforced in code by `DataAssets` and the data tools.
 */
export const DATA_ASSET_KINDS = ["file", "folder", "dataset"] as const;
export type DataAssetKind = (typeof DATA_ASSET_KINDS)[number];

/** Where the bytes live: a copy under the project data dir, the original path, or a URI. */
export const DATA_STORAGE = ["copied", "linked", "remote"] as const;
export type DataStorage = (typeof DATA_STORAGE)[number];

/** URI schemes a dataset may be registered under. Values never leave the daemon as fetches. */
export const REMOTE_SCHEMES = ["s3", "r2", "gs", "az", "hf", "https", "http"] as const;

export interface DataLimits {
  /** Hard cap on the bytes any sample hands to a model. Default 64 KB. */
  sampleBytes: number;
  /** Rows a sample returns when the caller names no count. Default 20. */
  sampleRows: number;
  /** Most rows a sample may ask for. Default 200. */
  maxSampleRows: number;
  /** Files (and folders) above this size are linked in place, never copied. Default 50 MB. */
  copyThresholdBytes: number;
  /** Bytes read from the head of a file for sniffing and column inference. Default 64 KB. */
  headBytes: number;
  /** Largest file whose rows are counted exactly; bigger files get an estimate. Default 256 MB. */
  rowCountMaxBytes: number;
  /** Largest JSON document parsed whole for shape inference. Default 8 MB. */
  jsonParseMaxBytes: number;
  /** Folder walks and imports refuse more entries than this. Default 10 000. */
  maxEntries: number;
  /** Folder walks and imports refuse more bytes than this. Default 2 GB. */
  maxTotalBytes: number;
  /** Folder walks stop at this depth. Default 32. */
  maxDepth: number;
  /** Uploads above this size are refused; register them by path instead. Default = copy threshold. */
  uploadMaxBytes: number;
  /** Entries a folder sample lists. Default 50. */
  folderSampleEntries: number;
  /** Rows kept in the row's stored sample (shown without touching the file). Default 5. */
  storedSampleRows: number;
  /** Bytes kept in the row's stored sample for text files. Default 1 KB. */
  storedSampleBytes: number;
}

export const DEFAULT_DATA_LIMITS: DataLimits = {
  sampleBytes: 64 * 1024,
  sampleRows: 20,
  maxSampleRows: 200,
  copyThresholdBytes: 50 * 1024 * 1024,
  headBytes: 64 * 1024,
  rowCountMaxBytes: 256 * 1024 * 1024,
  jsonParseMaxBytes: 8 * 1024 * 1024,
  maxEntries: 10_000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxDepth: 32,
  uploadMaxBytes: 50 * 1024 * 1024,
  folderSampleEntries: 50,
  storedSampleRows: 5,
  storedSampleBytes: 1024,
};

/** Merge overrides onto the defaults; every value must be a positive integer. */
export function resolveDataLimits(over: Partial<DataLimits> = {}): DataLimits {
  const out: DataLimits = { ...DEFAULT_DATA_LIMITS };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`data limit ${k} must be a positive number`);
    }
    (out as unknown as Record<string, number>)[k] = Math.floor(v);
  }
  if (over.uploadMaxBytes === undefined && over.copyThresholdBytes !== undefined) {
    out.uploadMaxBytes = out.copyThresholdBytes;
  }
  return out;
}

export const ColumnInfo = z.object({
  name: z.string(),
  /** integer, number, boolean, date, string, empty, null, object, array, mixed */
  type: z.string(),
});
export type ColumnInfo = z.infer<typeof ColumnInfo>;

export const DataMetadata = z.object({
  /** csv, jsonl, json, png, jpeg, gif, text, binary, parquet, sqlite, zip, folder, remote, ... */
  format: z.string(),
  mime: z.string().nullable(),
  encoding: z.string().nullable(),
  rowCount: z.number().int().nullable(),
  /** False when the count is an estimate from the head of a large file. */
  rowCountExact: z.boolean().nullable(),
  columns: z.array(ColumnInfo).nullable(),
  delimiter: z.string().nullable(),
  dimensions: z.object({ width: z.number().int(), height: z.number().int() }).nullable(),
  lineCount: z.number().int().nullable(),
  /** Folders: files found (within the walk limits). */
  entries: z.number().int().nullable(),
  /** Folders: file count per extension. */
  extensions: z.record(z.string(), z.number().int()).nullable(),
  /** Remote URIs: scheme and host. */
  scheme: z.string().nullable(),
  host: z.string().nullable(),
  /** True when the metadata came from a partial read (head of a large file, capped walk). */
  truncated: z.boolean(),
});
export type DataMetadata = z.infer<typeof DataMetadata>;

export const DataSample = z.object({
  kind: z.enum(["rows", "text", "entries", "none"]),
  rows: z.array(z.unknown()).optional(),
  text: z.string().optional(),
  entries: z.array(z.string()).optional(),
  /** Bytes of the source consumed by this sample. */
  bytes: z.number().int(),
  /** The hard cap that applied. */
  capBytes: z.number().int(),
  /** True when the source holds more than the sample shows. */
  truncated: z.boolean(),
  note: z.string(),
});
export type DataSample = z.infer<typeof DataSample>;

/**
 * The view the Data tab and the tools see. A superset of the UI's proposed `DataAssetView`
 * (id, projectIds, locator, name, sizeBytes, kind, ownerDeviceId, sample, registeredBy,
 * createdAt) so the page keeps parsing rows written by the state service's upload route.
 */
export const DataAssetView = z.object({
  id: z.string(),
  projectIds: z.array(z.string()),
  locator: z.string(),
  name: z.string(),
  sizeBytes: z.number().int(),
  kind: z.string(),
  ownerDeviceId: z.string().nullable(),
  sample: DataSample.nullable(),
  registeredBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  storage: z.enum(DATA_STORAGE),
  format: z.string(),
  mime: z.string().nullable(),
  metadata: DataMetadata.nullable(),
  /** Why the asset is linked rather than copied, and the LFS / R2 options. */
  note: z.string().nullable(),
  /** False when a local locator no longer exists (moved, unmounted, other machine). */
  available: z.boolean(),
});
export type DataAssetView = z.infer<typeof DataAssetView>;
export const DataAssetList = z.array(DataAssetView);

/** What `DataAssets` stores in the `data_asset.sample` JSON column. */
export const StoredAssetInfo = z.object({
  v: z.literal(1),
  name: z.string(),
  storage: z.enum(DATA_STORAGE),
  format: z.string(),
  mime: z.string().nullable(),
  note: z.string().nullable(),
  metadata: DataMetadata.nullable(),
  sample: DataSample.nullable(),
});
export type StoredAssetInfo = z.infer<typeof StoredAssetInfo>;

/** Who registers, removes or imports. Agents never get `remove`. */
export interface DataActor {
  humanId?: string | null;
  agentId?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
}

export const ImportedFile = z.object({
  rel: z.string(),
  sizeBytes: z.number().int(),
  assetId: z.string().nullable(),
});
export type ImportedFile = z.infer<typeof ImportedFile>;

export const GitignoreGuardResult = z.object({
  path: z.string(),
  added: z.array(z.string()),
});
export type GitignoreGuardResult = z.infer<typeof GitignoreGuardResult>;

export const ImportResultView = z.object({
  source: z.enum(["zip", "folder"]),
  projectId: z.string(),
  /** Where copies landed; null when a folder was linked in place. */
  destination: z.string().nullable(),
  imported: z.array(ImportedFile),
  skipped: z.array(z.object({ rel: z.string(), reason: z.string() })),
  totalBytes: z.number().int(),
  entryCount: z.number().int(),
  gitignore: GitignoreGuardResult.nullable(),
  /** Why a copy was not made (above the copy threshold). */
  note: z.string().nullable(),
});
export type ImportResultView = z.infer<typeof ImportResultView>;

/** Where large data belongs instead of git; appended to every "linked, not copied" note. */
export const LARGE_DATA_ADVICE =
  "Large data never goes into git. Keep it at its original location, put it in Git LFS " +
  "(git lfs track), or upload it to an R2 or S3 bucket and register the r2:// or s3:// URI instead.";

/** The note attached to every linked large asset. */
export function largeDataNote(sizeBytes: number, thresholdBytes: number): string {
  return (
    `Linked in place: ${formatBytes(sizeBytes)} is above the copy threshold of ` +
    `${formatBytes(thresholdBytes)}. ${LARGE_DATA_ADVICE}`
  );
}

/** The note attached to a linked folder whose walk a limit stopped (its size is unknown). */
export function truncatedWalkNote(limit: "entries" | "bytes" | "depth", value: number): string {
  const shown = limit === "bytes" ? formatBytes(value) : String(value);
  return (
    `Linked in place: the folder walk stopped at the ${limit} limit (${shown}), so the folder ` +
    "is linked where it sits and never copied; the entry count and size recorded are partial. " +
    LARGE_DATA_ADVICE
  );
}

/** The note attached to a remote asset whose URI carried credentials, a query or a fragment. */
export const URI_STRIPPED_NOTE =
  "Credentials and query parameters were dropped from the URI before it was stored; keep them " +
  "in the vault as a secret reference and let the run inject them when it reads the data.";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}
