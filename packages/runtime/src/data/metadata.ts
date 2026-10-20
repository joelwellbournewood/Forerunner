import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { basename, extname } from "@forerunner/platform";
import type { ColumnInfo, DataLimits, DataMetadata, DataSample } from "./types.ts";
import { type WalkLimits, type WalkResult, walkFolder } from "./walk.ts";

/**
 * Metadata and samples for files, folders and URIs. Every read here is bounded: the head of
 * a file for sniffing and inference, a streamed newline count for row counts up to a size
 * limit, and samples capped at `limits.sampleBytes`. Nothing in this module returns a whole
 * file.
 */

const FORMAT_BY_EXT: Record<string, string> = {
  ".csv": "csv",
  ".tsv": "csv",
  ".tab": "csv",
  ".json": "json",
  ".geojson": "json",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".gif": "gif",
  ".webp": "webp",
  ".pdf": "pdf",
  ".zip": "zip",
  ".gz": "gzip",
  ".tgz": "gzip",
  ".parquet": "parquet",
  ".sqlite": "sqlite",
  ".sqlite3": "sqlite",
  ".db": "sqlite",
  ".txt": "text",
  ".md": "text",
  ".log": "text",
  ".xml": "text",
  ".yaml": "text",
  ".yml": "text",
  ".toml": "text",
  ".html": "text",
  ".htm": "text",
  ".py": "text",
  ".ts": "text",
  ".js": "text",
  ".sql": "text",
  ".sh": "text",
  ".ps1": "text",
  ".ini": "text",
  ".cfg": "text",
};

const MIME_BY_FORMAT: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  jsonl: "application/x-ndjson",
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  gzip: "application/gzip",
  parquet: "application/vnd.apache.parquet",
  sqlite: "application/vnd.sqlite3",
  text: "text/plain",
  binary: "application/octet-stream",
  folder: "inode/directory",
  remote: "application/x-uri",
};

const TEXT_FORMATS: ReadonlySet<string> = new Set(["csv", "json", "jsonl", "text"]);

export function formatFromExtension(name: string): string | null {
  return FORMAT_BY_EXT[extname(name).toLowerCase()] ?? null;
}

export function mimeFor(format: string, name?: string): string | null {
  if (format === "text" && name) {
    const ext = extname(name).toLowerCase();
    if (ext === ".md") return "text/markdown";
    if (ext === ".html" || ext === ".htm") return "text/html";
    if (ext === ".xml") return "application/xml";
  }
  if (format === "csv" && name && /\.(tsv|tab)$/i.test(name)) return "text/tab-separated-values";
  return MIME_BY_FORMAT[format] ?? null;
}

/** Magic bytes decide for binary formats; the extension decides between text formats. */
export function sniffFormat(head: Uint8Array): string | null {
  const at = (i: number) => head[i] ?? -1;
  if (head.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
    return "png";
  if (head.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpeg";
  if (head.length >= 6 && ascii(head, 0, 3) === "GIF") return "gif";
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP")
    return "webp";
  if (head.length >= 5 && ascii(head, 0, 5) === "%PDF-") return "pdf";
  if (
    head.length >= 4 &&
    at(0) === 0x50 &&
    at(1) === 0x4b &&
    (at(2) === 3 || at(2) === 5 || at(2) === 7)
  )
    return "zip";
  if (head.length >= 2 && at(0) === 0x1f && at(1) === 0x8b) return "gzip";
  if (head.length >= 4 && ascii(head, 0, 4) === "PAR1") return "parquet";
  if (head.length >= 16 && ascii(head, 0, 15) === "SQLite format 3") return "sqlite";
  return null;
}

function ascii(buf: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to && i < buf.length; i++) s += String.fromCharCode(buf[i] ?? 0);
  return s;
}

export type TextEncodingName =
  | "utf-8"
  | "utf-8-bom"
  | "utf-16le"
  | "utf-16be"
  | "latin1"
  | "binary";

/** BOMs first, then a strict UTF-8 decode of the head; NUL bytes mean binary. */
export function detectEncoding(head: Uint8Array): TextEncodingName {
  if (head.length === 0) return "utf-8";
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)
    return "utf-8-bom";
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return "utf-16be";
  let nul = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) nul++;
  if (nul > 0) {
    // UTF-16 without a BOM shows a NUL in every other byte of ASCII text.
    if (nul >= head.length / 3 && head.length >= 4) {
      let evenNul = 0;
      let oddNul = 0;
      for (let i = 0; i < head.length; i++) {
        if (head[i] === 0) {
          if (i % 2 === 0) evenNul++;
          else oddNul++;
        }
      }
      if (oddNul > evenNul * 4) return "utf-16le";
      if (evenNul > oddNul * 4) return "utf-16be";
    }
    return "binary";
  }
  for (let trim = 0; trim <= 3 && trim < head.length; trim++) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - trim));
      return "utf-8";
    } catch {
      // a multi-byte character may be cut at the end of the head; try a shorter slice
    }
  }
  return "latin1";
}

export function decodeText(buf: Uint8Array, encoding: TextEncodingName): string {
  switch (encoding) {
    case "utf-8-bom":
      return new TextDecoder("utf-8").decode(buf.subarray(3));
    case "utf-16le":
      return new TextDecoder("utf-16le").decode(buf);
    case "utf-16be":
      return new TextDecoder("utf-16be").decode(buf);
    case "latin1":
      return new TextDecoder("latin1").decode(buf);
    case "binary":
      return "";
    default:
      return new TextDecoder("utf-8").decode(buf);
  }
}

// ---------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------

export function pngDimensions(head: Uint8Array): { width: number; height: number } | null {
  if (head.length < 24 || ascii(head, 12, 16) !== "IHDR") return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** Walks the JPEG marker chain to the first SOF marker within the head. */
export function jpegDimensions(head: Uint8Array): { width: number; height: number } | null {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let i = 2;
  while (i + 9 < head.length) {
    if (head[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = head[i + 1] ?? 0;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = dv.getUint16(i + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

export function gifDimensions(head: Uint8Array): { width: number; height: number } | null {
  if (head.length < 10) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
}

// ---------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------

export function sniffDelimiter(firstLine: string): string {
  const candidates = [",", "\t", ";", "|"];
  let best = ",";
  let bestCount = 0;
  for (const c of candidates) {
    const n = firstLine.split(c).length - 1;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/**
 * RFC 4180 parser over a string: quoted fields, doubled quotes, newlines inside quotes.
 * Returns up to `maxRows` rows and whether the text held more. Empty lines are skipped.
 */
export function parseCsv(
  text: string,
  delimiter: string,
  maxRows: number,
): { rows: string[][]; complete: boolean; consumed: number } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let i = 0;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || (row[0] ?? "") !== "") rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      if (rows.length >= maxRows) return { rows, complete: false, consumed: i };
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return { rows, complete: true, consumed: n };
}

const INT_RE = /^[-+]?\d{1,18}$/;
const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const BOOL_RE = /^(true|false|yes|no|t|f|y|n)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[-+]\d{2}:?\d{2})?)?$/;

export function inferScalarType(v: string): string {
  const s = v.trim();
  if (s === "" || /^(null|na|n\/a|nan|none)$/i.test(s)) return "empty";
  if (INT_RE.test(s)) return "integer";
  if (NUM_RE.test(s)) return "number";
  if (BOOL_RE.test(s)) return "boolean";
  if (DATE_RE.test(s)) return "date";
  return "string";
}

export function mergeTypes(types: Iterable<string>): string {
  const set = new Set<string>();
  for (const t of types) if (t !== "empty") set.add(t);
  if (set.size === 0) return "empty";
  if (set.size === 1) return [...set][0] as string;
  if (set.size === 2 && set.has("integer") && set.has("number")) return "number";
  return "mixed";
}

export function inferJsonType(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "number":
      return Number.isInteger(v) ? "integer" : "number";
    case "boolean":
      return "boolean";
    case "string":
      return DATE_RE.test(v) ? "date" : "string";
    case "object":
      return "object";
    default:
      return "mixed";
  }
}

export function csvColumns(rows: string[][]): ColumnInfo[] {
  const header = rows[0] ?? [];
  return header.map((name, idx) => ({
    name: name.trim() || `column_${idx + 1}`,
    type: mergeTypes(rows.slice(1).map((r) => inferScalarType(r[idx] ?? ""))),
  }));
}

export function objectColumns(objects: unknown[]): ColumnInfo[] {
  const types = new Map<string, string[]>();
  for (const o of objects) {
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const list = types.get(k) ?? [];
      list.push(inferJsonType(v));
      types.set(k, list);
    }
  }
  return [...types.entries()].map(([name, ts]) => ({
    name,
    type: mergeTypes(ts.map((t) => (t === "null" ? "empty" : t))),
  }));
}

export function csvRowsToObjects(rows: string[][]): Record<string, string>[] {
  const header = rows[0] ?? [];
  return rows
    .slice(1)
    .map((r) =>
      Object.fromEntries(header.map((h, i) => [h.trim() || `column_${i + 1}`, r[i] ?? ""])),
    );
}

// ---------------------------------------------------------------------------------------
// File reads, all bounded
// ---------------------------------------------------------------------------------------

export function readHead(path: string, maxBytes: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Streamed count of lines up to `maxBytes`; beyond that the count is an estimate. */
export async function countLines(
  path: string,
  sizeBytes: number,
  maxBytes: number,
): Promise<{ lines: number; exact: boolean }> {
  if (sizeBytes === 0) return { lines: 0, exact: true };
  const limit = Math.min(sizeBytes, maxBytes);
  let newlines = 0;
  let read = 0;
  let last = 0x0a;
  const stream = createReadStream(path, { start: 0, end: limit - 1, highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    const b = chunk as Uint8Array;
    read += b.length;
    for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) newlines++;
    last = b[b.length - 1] ?? last;
  }
  if (limit >= sizeBytes) {
    return { lines: newlines + (last === 0x0a ? 0 : 1), exact: true };
  }
  const perByte = newlines / Math.max(1, read);
  return { lines: Math.round(perByte * sizeBytes), exact: false };
}

export interface FileDescription {
  format: string;
  mime: string | null;
  encoding: TextEncodingName | null;
  metadata: DataMetadata;
  /** A small sample stored on the row (bounded by storedSample* limits). */
  storedSample: DataSample | null;
}

const EMPTY_META: DataMetadata = {
  format: "binary",
  mime: null,
  encoding: null,
  rowCount: null,
  rowCountExact: null,
  columns: null,
  delimiter: null,
  dimensions: null,
  lineCount: null,
  entries: null,
  extensions: null,
  scheme: null,
  host: null,
  truncated: false,
};

export function emptyMetadata(over: Partial<DataMetadata> = {}): DataMetadata {
  return { ...EMPTY_META, ...over };
}

/** Decide the format of a file from its magic bytes, else its extension, else its text-ness. */
export function detectFormat(
  name: string,
  head: Uint8Array,
): { format: string; encoding: TextEncodingName | null } {
  const sniffed = sniffFormat(head);
  if (sniffed) return { format: sniffed, encoding: null };
  const encoding = detectEncoding(head);
  const byExt = formatFromExtension(name);
  if (encoding === "binary")
    return { format: byExt && !TEXT_FORMATS.has(byExt) ? byExt : "binary", encoding };
  if (byExt && TEXT_FORMATS.has(byExt)) return { format: byExt, encoding };
  if (byExt) return { format: byExt, encoding };
  return { format: "text", encoding };
}

export async function describeFile(
  path: string,
  sizeBytes: number,
  limits: DataLimits,
): Promise<FileDescription> {
  const name = basename(path);
  const head = readHead(path, Math.min(limits.headBytes, Math.max(sizeBytes, 0)));
  const { format, encoding } = detectFormat(name, head);
  const mime = mimeFor(format, name);
  const truncatedHead = head.length < sizeBytes;
  const meta = emptyMetadata({ format, mime, encoding, truncated: truncatedHead });
  let storedSample: DataSample | null = null;

  if (format === "png") meta.dimensions = pngDimensions(head);
  else if (format === "jpeg") meta.dimensions = jpegDimensions(head);
  else if (format === "gif") meta.dimensions = gifDimensions(head);

  if (format === "csv" && encoding && encoding !== "binary") {
    const text = decodeText(head, encoding);
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    const delimiter = /\.(tsv|tab)$/i.test(name) ? "\t" : sniffDelimiter(firstLine);
    const parsed = parseCsv(text, delimiter, limits.maxSampleRows + 1);
    meta.delimiter = delimiter;
    meta.columns = csvColumns(parsed.rows);
    const counted = await countLines(path, sizeBytes, limits.rowCountMaxBytes);
    meta.lineCount = counted.lines;
    meta.rowCount = Math.max(0, counted.lines - 1);
    meta.rowCountExact = counted.exact;
    const rows = csvRowsToObjects(parsed.rows).slice(0, limits.storedSampleRows);
    storedSample = {
      kind: "rows",
      rows,
      bytes: Math.min(head.length, parsed.consumed),
      capBytes: limits.storedSampleBytes,
      truncated: rows.length < meta.rowCount,
      note: `first ${rows.length} of ${meta.rowCount}${counted.exact ? "" : " (estimated)"} rows`,
    };
  } else if (format === "jsonl" && encoding && encoding !== "binary") {
    const text = decodeText(head, encoding);
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (truncatedHead) lines.pop();
    const objects = lines
      .slice(0, limits.maxSampleRows)
      .map(parseJsonLoose)
      .filter((o) => o !== undefined);
    meta.columns = objectColumns(objects);
    const counted = await countLines(path, sizeBytes, limits.rowCountMaxBytes);
    meta.lineCount = counted.lines;
    meta.rowCount = counted.lines;
    meta.rowCountExact = counted.exact;
    const rows = objects.slice(0, limits.storedSampleRows);
    storedSample = {
      kind: "rows",
      rows,
      bytes: head.length,
      capBytes: limits.storedSampleBytes,
      truncated: rows.length < (meta.rowCount ?? 0),
      note: `first ${rows.length} of ${meta.rowCount}${counted.exact ? "" : " (estimated)"} rows`,
    };
  } else if (format === "json" && encoding && encoding !== "binary") {
    const json = describeJson(path, sizeBytes, head, encoding, limits);
    Object.assign(meta, json.meta);
    storedSample = json.sample;
  } else if (format === "text" && encoding && encoding !== "binary") {
    const counted = await countLines(path, sizeBytes, limits.rowCountMaxBytes);
    meta.lineCount = counted.lines;
    meta.rowCountExact = counted.exact;
    const text = decodeText(
      head.subarray(0, Math.min(head.length, limits.storedSampleBytes)),
      encoding,
    );
    storedSample = {
      kind: "text",
      text,
      bytes: Math.min(head.length, limits.storedSampleBytes),
      capBytes: limits.storedSampleBytes,
      truncated: sizeBytes > limits.storedSampleBytes,
      note: `first ${Math.min(sizeBytes, limits.storedSampleBytes)} bytes of ${sizeBytes}`,
    };
  }
  return { format, mime, encoding, metadata: meta, storedSample };
}

function parseJsonLoose(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function describeJson(
  path: string,
  sizeBytes: number,
  head: Uint8Array,
  encoding: TextEncodingName,
  limits: DataLimits,
): { meta: Partial<DataMetadata>; sample: DataSample | null } {
  let doc: unknown;
  let whole = false;
  if (sizeBytes <= limits.jsonParseMaxBytes) {
    const buf = sizeBytes <= head.length ? head : readHead(path, sizeBytes);
    doc = parseJsonLoose(decodeText(buf, encoding));
    whole = true;
  }
  if (doc === undefined) {
    // Too large or not parseable in one go: report the shape of the head only.
    const text = decodeText(head, encoding).trimStart();
    const shape = text.startsWith("[") ? "array" : text.startsWith("{") ? "object" : "unknown";
    return {
      meta: { truncated: true, columns: shape === "unknown" ? null : [{ name: "$", type: shape }] },
      sample: {
        kind: "text",
        text: decodeText(head.subarray(0, limits.storedSampleBytes), encoding),
        bytes: Math.min(head.length, limits.storedSampleBytes),
        capBytes: limits.storedSampleBytes,
        truncated: true,
        note: whole
          ? "the document did not parse as JSON; showing its head"
          : `document larger than ${limits.jsonParseMaxBytes} bytes; shape from its head only`,
      },
    };
  }
  if (Array.isArray(doc)) {
    const objects = doc.slice(0, limits.maxSampleRows);
    const rows = doc.slice(0, limits.storedSampleRows);
    return {
      meta: {
        rowCount: doc.length,
        rowCountExact: true,
        columns: objects.every((o) => o && typeof o === "object" && !Array.isArray(o))
          ? objectColumns(objects)
          : [{ name: "$[*]", type: mergeTypes(objects.map(inferJsonType)) }],
        truncated: false,
      },
      sample: {
        kind: "rows",
        rows,
        bytes: Math.min(sizeBytes, limits.storedSampleBytes),
        capBytes: limits.storedSampleBytes,
        truncated: rows.length < doc.length,
        note: `first ${rows.length} of ${doc.length} elements`,
      },
    };
  }
  if (doc && typeof doc === "object") {
    const o = doc as Record<string, unknown>;
    const keys = Object.keys(o);
    return {
      meta: {
        rowCount: null,
        rowCountExact: null,
        columns: keys.map((k) => ({ name: k, type: inferJsonType(o[k]) })),
        truncated: false,
      },
      sample: {
        kind: "text",
        text: clip(JSON.stringify(previewObject(o), null, 1), limits.storedSampleBytes),
        bytes: Math.min(sizeBytes, limits.storedSampleBytes),
        capBytes: limits.storedSampleBytes,
        truncated: sizeBytes > limits.storedSampleBytes,
        note: `top-level object with ${keys.length} keys`,
      },
    };
  }
  return {
    meta: { columns: [{ name: "$", type: inferJsonType(doc) }], truncated: false },
    sample: {
      kind: "text",
      text: clip(JSON.stringify(doc), limits.storedSampleBytes),
      bytes: Math.min(sizeBytes, limits.storedSampleBytes),
      capBytes: limits.storedSampleBytes,
      truncated: false,
      note: "scalar document",
    },
  };
}

function previewObject(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o).slice(0, 40)) {
    if (Array.isArray(v)) out[k] = `[array of ${v.length}]`;
    else if (v && typeof v === "object") out[k] = `{object with ${Object.keys(v).length} keys}`;
    else if (typeof v === "string") out[k] = clip(v, 80);
    else out[k] = v;
  }
  return out;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------------------------------
// Samples for agents: capped by bytes and rows
// ---------------------------------------------------------------------------------------

export interface SampleRequest {
  rows: number;
  bytes: number;
}

/** First N rows (csv, jsonl, json arrays) or first N bytes of text; never more than `bytes`. */
export function sampleFile(
  path: string,
  sizeBytes: number,
  format: string,
  encoding: TextEncodingName | null,
  delimiter: string | null,
  req: SampleRequest,
  limits: DataLimits,
): DataSample {
  const cap = Math.min(req.bytes, limits.sampleBytes);
  const rows = Math.min(req.rows, limits.maxSampleRows);
  const head = readHead(path, Math.min(cap, sizeBytes));
  const enc = encoding ?? detectEncoding(head);
  if (enc === "binary" || !TEXT_FORMATS.has(format)) {
    const shown = Math.min(head.length, 256);
    return {
      kind: "text",
      text: `hex of the first ${shown} bytes: ${Buffer.from(head.subarray(0, shown)).toString("hex")}`,
      bytes: shown,
      capBytes: cap,
      truncated: sizeBytes > shown,
      note: `binary ${format}; a model never receives the bytes themselves`,
    };
  }
  const text = decodeText(head, enc);
  if (format === "csv") {
    const d = delimiter ?? sniffDelimiter(text.split(/\r?\n/, 1)[0] ?? "");
    const parsed = parseCsv(text, d, rows + 1);
    const objects = csvRowsToObjects(parsed.rows);
    const more = !parsed.complete || head.length < sizeBytes;
    return {
      kind: "rows",
      rows: objects,
      bytes: Math.min(parsed.consumed, head.length),
      capBytes: cap,
      truncated: more,
      note: `first ${objects.length} rows${more ? " of more" : ""}`,
    };
  }
  if (format === "jsonl") {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (head.length < sizeBytes) lines.pop();
    const objects = lines
      .slice(0, rows)
      .map(parseJsonLoose)
      .filter((o) => o !== undefined);
    const more = head.length < sizeBytes || lines.length > rows;
    return {
      kind: "rows",
      rows: objects,
      bytes: head.length,
      capBytes: cap,
      truncated: more,
      note: `first ${objects.length} rows${more ? " of more" : ""}`,
    };
  }
  if (format === "json" && sizeBytes <= head.length) {
    const doc = parseJsonLoose(text);
    if (Array.isArray(doc)) {
      const slice = doc.slice(0, rows);
      return {
        kind: "rows",
        rows: slice,
        bytes: head.length,
        capBytes: cap,
        truncated: slice.length < doc.length,
        note: `first ${slice.length} of ${doc.length} elements`,
      };
    }
  }
  return {
    kind: "text",
    text,
    bytes: head.length,
    capBytes: cap,
    truncated: head.length < sizeBytes,
    note: `first ${head.length} bytes of ${sizeBytes}`,
  };
}

// ---------------------------------------------------------------------------------------
// Folders and URIs
// ---------------------------------------------------------------------------------------

export function describeFolder(
  path: string,
  limits: DataLimits,
): { walk: WalkResult; metadata: DataMetadata; storedSample: DataSample } {
  const walkLimits: WalkLimits = {
    maxEntries: limits.maxEntries,
    maxTotalBytes: limits.maxTotalBytes,
    maxDepth: limits.maxDepth,
  };
  const walk = walkFolder(path, walkLimits);
  const metadata = emptyMetadata({
    format: "folder",
    mime: MIME_BY_FORMAT.folder ?? null,
    entries: walk.files.length,
    extensions: walk.extensions,
    truncated: walk.truncated,
  });
  return {
    walk,
    metadata,
    storedSample: folderSample(walk, limits.folderSampleEntries, limits.sampleBytes),
  };
}

export function folderSample(walk: WalkResult, maxEntries: number, cap: number): DataSample {
  const entries = walk.files.slice(0, maxEntries).map((f) => `${f.rel} (${f.sizeBytes} B)`);
  return {
    kind: "entries",
    entries,
    bytes: entries.join("\n").length,
    capBytes: cap,
    truncated: walk.files.length > entries.length || walk.truncated,
    note: `${entries.length} of ${walk.files.length}${walk.truncated ? "+" : ""} files`,
  };
}

const URI_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

export interface ParsedUri {
  scheme: string;
  /** Host and port; never the userinfo. */
  host: string;
  /** The last path segment (the host when there is no path). */
  name: string;
  /** `scheme://host/path`: what gets stored, shown and audited. */
  locator: string;
  /** True when the source carried userinfo, a query or a fragment that `locator` drops. */
  stripped: boolean;
}

/**
 * Split a URI into its parts and a `locator` that keeps only `scheme://host/path`.
 * Credentials in the authority (`user:pass@`) and the query and fragment (presigned
 * signatures, access tokens) are dropped so they never reach the store, the audit log, an
 * approval request or a model. Returns null for anything that is not `scheme://...`
 * (Windows drive letters included).
 */
export function parseUri(source: string): ParsedUri | null {
  const m = URI_RE.exec(source.trim());
  if (!m) return null;
  const scheme = (m[1] ?? "").toLowerCase();
  const whole = m[2] ?? "";
  const rest = whole.split(/[?#]/, 1)[0] ?? "";
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf("@");
  const host = at === -1 ? authority : authority.slice(at + 1);
  const path = slash === -1 ? "" : rest.slice(slash + 1);
  const name = path.split("/").filter(Boolean).pop() ?? host;
  const locator = `${scheme}://${host}${slash === -1 ? "" : `/${path}`}`;
  return {
    scheme,
    host,
    name: name || host || scheme,
    locator,
    stripped: at !== -1 || rest.length !== whole.length,
  };
}

export function describeRemote(uri: { scheme: string; host: string }): DataMetadata {
  return emptyMetadata({
    format: "remote",
    mime: MIME_BY_FORMAT.remote ?? null,
    scheme: uri.scheme,
    host: uri.host,
    truncated: false,
  });
}
