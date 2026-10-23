import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import {
  type AppDirs,
  appDirs,
  basename,
  dirname,
  errorMessage,
  ForerunnerError,
  isInside,
  join,
  normalizeNewlines,
  resolve,
} from "@forerunner/platform";
import {
  LESSON_SCOPES,
  LESSON_STATUSES,
  type LessonRow,
  type LessonStatus,
} from "@forerunner/state";
import { type Embedder, vectorToJson } from "./embedding.ts";
import {
  LESSON_FORMAT,
  type LessonDoc,
  type LessonStore,
  type MemoryScope,
  rowToDoc,
} from "./types.ts";

/**
 * Lessons on disk (ADR 0002): one Markdown file with YAML frontmatter per lesson, one root per
 * scope, LF on write, CRLF accepted on read, sorted keys, atomic writes. The SQLite/Postgres
 * row is the derived index; `reconcile` rebuilds it from the files.
 *
 *   <data>/memory/agents/<agent_id>/lessons/<id>.md   private: only this machine, only this agent
 *   <data>/memory/critic/lessons/<id>.md
 *   <data>/memory/shared/lessons/<id>.md
 *   <root>/catalog.md per scope root, generated
 */

export const FRONTMATTER_KEYS = [
  "author_agent",
  "author_human",
  "confidence",
  "created_at",
  "flags",
  "format",
  "hit_count",
  "id",
  "last_used",
  "owner_agent_id",
  "pinned",
  "project_id",
  "scope",
  "source",
  "status",
  "superseded_by",
  "tags",
  "updated_at",
  "version",
] as const;

const REQUIRED_KEYS = FRONTMATTER_KEYS.filter((k) => k !== "flags" && k !== "format");

export type ParseResult =
  | { ok: true; doc: LessonDoc; format: number }
  | { ok: false; error: string };

type Scalar = string | number | boolean | null;

function isBareString(s: string): boolean {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9_.:/@+-]*$/.test(s) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(s) &&
    !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)
  );
}

function renderScalar(v: Scalar): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  return isBareString(v) ? v : JSON.stringify(v);
}

function renderValue(v: Scalar | string[]): string {
  if (Array.isArray(v)) return `[${v.map((s) => renderScalar(s)).join(", ")}]`;
  return renderScalar(v);
}

function parseScalar(raw: string): Scalar {
  const s = raw.trim();
  if (s === "null" || s === "~" || s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw new Error(`bad quoted string ${s}`);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
    return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function parseArray(raw: string): string[] {
  const s = raw.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) throw new Error(`expected a flow array: ${s}`);
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (quoted) {
      cur += ch;
      if (ch === "\\" && i + 1 < inner.length) {
        cur += inner[++i];
      } else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (quoted) throw new Error("unterminated quoted string in array");
  out.push(cur);
  return out.map((item) => {
    const v = parseScalar(item);
    if (typeof v !== "string") throw new Error(`array items must be strings: ${item.trim()}`);
    return v;
  });
}

/** Serialise a lesson to its file text: sorted frontmatter, LF, body = text + newline. */
export function serializeLesson(doc: LessonDoc): string {
  const fields: Record<(typeof FRONTMATTER_KEYS)[number], Scalar | string[]> = {
    author_agent: doc.author_agent,
    author_human: doc.author_human,
    confidence: doc.confidence,
    created_at: doc.created_at,
    flags: [...doc.flags].sort(),
    format: LESSON_FORMAT,
    hit_count: doc.hit_count,
    id: doc.id,
    last_used: doc.last_used,
    owner_agent_id: doc.owner_agent_id,
    pinned: doc.pinned,
    project_id: doc.project_id,
    scope: doc.scope,
    source: doc.source,
    status: doc.status,
    superseded_by: doc.superseded_by,
    tags: [...doc.tags],
    updated_at: doc.updated_at,
    version: doc.version,
  };
  const lines = ["---"];
  for (const key of FRONTMATTER_KEYS) lines.push(`${key}: ${renderValue(fields[key])}`);
  lines.push("---");
  const body = normalizeNewlines(doc.text).replace(/\n+$/, "");
  return `${lines.join("\n")}\n${body}\n`;
}

/**
 * Strict, non-throwing parse: frontmatter present, every required key present and typed,
 * no unknown keys, no duplicate keys. CRLF is accepted; the body is the lesson text.
 */
export function parseLesson(fileText: string): ParseResult {
  const text = normalizeNewlines(fileText);
  if (!text.startsWith("---\n")) return { ok: false, error: "missing frontmatter" };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { ok: false, error: "unterminated frontmatter" };
  const header = text.slice(4, end);
  const body = text.slice(end + 5).replace(/\n+$/, "");
  const raw = new Map<string, string>();
  for (const line of header.split("\n")) {
    if (!line.trim()) continue;
    const m = /^([a-z_]+):\s?(.*)$/.exec(line);
    if (!m) return { ok: false, error: `bad frontmatter line: ${line}` };
    const key = m[1] as string;
    if (!(FRONTMATTER_KEYS as readonly string[]).includes(key))
      return { ok: false, error: `unknown frontmatter key: ${key}` };
    if (raw.has(key)) return { ok: false, error: `duplicate frontmatter key: ${key}` };
    raw.set(key, m[2] ?? "");
  }
  for (const key of REQUIRED_KEYS) {
    if (!raw.has(key)) return { ok: false, error: `missing frontmatter key: ${key}` };
  }
  try {
    const str = (k: string): string => {
      const v = parseScalar(raw.get(k) ?? "");
      if (typeof v !== "string" || !v) throw new Error(`${k} must be a non-empty string`);
      return v;
    };
    const strOrNull = (k: string): string | null => {
      const v = parseScalar(raw.get(k) ?? "");
      if (v === null) return null;
      if (typeof v !== "string" || !v) throw new Error(`${k} must be a string or null`);
      return v;
    };
    const num = (k: string): number => {
      const v = parseScalar(raw.get(k) ?? "");
      if (typeof v !== "number") throw new Error(`${k} must be a number`);
      return v;
    };
    const bool = (k: string): boolean => {
      const v = parseScalar(raw.get(k) ?? "");
      if (typeof v !== "boolean") throw new Error(`${k} must be true or false`);
      return v;
    };
    const format = raw.has("format") ? num("format") : LESSON_FORMAT;
    if (format > LESSON_FORMAT) throw new Error(`format ${format} is newer than ${LESSON_FORMAT}`);
    const scope = str("scope");
    if (!(LESSON_SCOPES as readonly string[]).includes(scope))
      throw new Error(`scope must be one of ${LESSON_SCOPES.join(", ")}`);
    const status = str("status");
    if (!(LESSON_STATUSES as readonly string[]).includes(status))
      throw new Error(`status must be one of ${LESSON_STATUSES.join(", ")}`);
    const confidence = num("confidence");
    if (confidence < 0 || confidence > 1) throw new Error("confidence must be within 0..1");
    const hit_count = num("hit_count");
    if (!Number.isInteger(hit_count) || hit_count < 0)
      throw new Error("hit_count must be a non-negative integer");
    const version = num("version");
    if (!Number.isInteger(version) || version < 1) throw new Error("version must be >= 1");
    if (!body.trim()) throw new Error("lesson body is empty");
    const doc: LessonDoc = {
      id: str("id"),
      scope: scope as MemoryScope,
      owner_agent_id: strOrNull("owner_agent_id"),
      project_id: strOrNull("project_id"),
      text: body,
      source: (parseScalar(raw.get("source") ?? "") ?? "") as string,
      tags: parseArray(raw.get("tags") ?? "[]"),
      confidence,
      last_used: strOrNull("last_used"),
      hit_count,
      superseded_by: strOrNull("superseded_by"),
      pinned: bool("pinned"),
      status: status as LessonStatus,
      created_at: str("created_at"),
      updated_at: str("updated_at"),
      author_agent: strOrNull("author_agent"),
      author_human: strOrNull("author_human"),
      version,
      flags: raw.has("flags") ? parseArray(raw.get("flags") ?? "[]") : [],
    };
    if (typeof doc.source !== "string") throw new Error("source must be a string");
    if (doc.scope === "agent_private" && !doc.owner_agent_id)
      throw new Error("agent_private lessons need owner_agent_id");
    return { ok: true, doc, format };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Credential shapes a lesson may never carry (mirrors scripts/secret-scan.mjs). */
const SECRET_SHAPES: readonly RegExp[] = [
  /sk-ant-(?:api|oat|admin)\d{2}-[A-Za-z0-9_-]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9+/_=-]{24,}["']/i,
];

/**
 * Paths that identify a person's machine or account (`/home/<user>`, `/Users/<user>`, `/root`,
 * `C:\Users\<user>`); a critic or shared lesson must not name one. Generic system paths such as
 * `/tmp/`, `/var/log` or `D:\build` are legitimate content ("tests must not write to /tmp/").
 */
const HOME_PATH =
  /(?:^|[\s"'(`])(?:[A-Za-z]:\\Users\\|\/(?:home|Users)\/[^\s/"']+|\/root(?:\/|\b))/;

/** True when `text` carries a credential shape; such text is never written or rendered. */
export function hasSecretShape(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

/** Lesson ids (the state store's UUIDv7) as they appear in a lesson text. */
const LESSON_ID_IN_TEXT =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

/** Distinct lesson ids cited in `text`, lower-cased, in order of first appearance. */
export function citedLessonIds(text: string): string[] {
  return [...new Set((text.match(LESSON_ID_IN_TEXT) ?? []).map((s) => s.toLowerCase()))];
}

export const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TEXT_MIN = 20;
export const TEXT_MAX = 2000;

/** Lint rules enforced by code, not a prompt (ADR 0002). Empty list means clean. */
export function lintLesson(doc: LessonDoc): string[] {
  const problems: string[] = [];
  if (doc.text.length < TEXT_MIN || doc.text.length > TEXT_MAX)
    problems.push(`text must be ${TEXT_MIN}-${TEXT_MAX} characters (is ${doc.text.length})`);
  for (const tag of doc.tags) if (!TAG_PATTERN.test(tag)) problems.push(`bad tag: ${tag}`);
  if (new Set(doc.tags).size !== doc.tags.length) problems.push("duplicate tags");
  if (!(doc.confidence >= 0 && doc.confidence <= 1)) problems.push("confidence outside 0..1");
  if (hasSecretShape(doc.text)) problems.push("text contains a secret shape");
  if (doc.scope !== "agent_private" && HOME_PATH.test(doc.text))
    problems.push("critic and shared lessons must not name a home-directory path");
  if (doc.scope === "agent_private" && !doc.owner_agent_id)
    problems.push("private lesson without owner");
  if (doc.scope !== "agent_private" && doc.owner_agent_id)
    problems.push("non-private lesson with an owner");
  return problems;
}

export function memoryRoot(dirs: AppDirs = appDirs()): string {
  return join(dirs.data, "memory");
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Temp file in the same directory, fsync, rename over the target. */
export async function atomicWriteText(target: string, text: string): Promise<void> {
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "wx");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, target);
  } catch (e) {
    try {
      if (handle) await handle.close();
      await fs.rm(tmp, { force: true });
    } catch {
      // nothing more to do
    }
    throw new ForerunnerError("unavailable", `cannot write lesson file: ${errorMessage(e)}`, {
      details: { target },
      cause: e,
    });
  }
}

/** Per scope root: which embedder (and lesson format) the index rows were built with. */
export const INDEX_META_FILE = "index.json";

export interface IndexMeta {
  embedder: string;
  dims: number;
  format: number;
}

export interface ListedLesson {
  path: string;
  doc: LessonDoc;
}

export interface ListResult {
  lessons: ListedLesson[];
  /** Files that failed to parse; the scope's load is reported, never partially trusted. */
  invalid: { path: string; error: string }[];
}

/** Scope roots and lesson files under one memory root. Refuses any path outside the root. */
export class LessonFiles {
  readonly root: string;

  constructor(root: string = memoryRoot()) {
    this.root = resolve(root);
  }

  scopeRoot(scope: MemoryScope, ownerAgentId?: string | null): string {
    let dir: string;
    if (scope === "agent_private") {
      if (!ownerAgentId) {
        throw new ForerunnerError("validation", "agent_private scope needs an owner agent id");
      }
      if (!/^[A-Za-z0-9_-]+$/.test(ownerAgentId)) {
        throw new ForerunnerError("validation", "owner agent id is not a safe path segment", {
          details: { ownerAgentId },
        });
      }
      dir = join(this.root, "agents", ownerAgentId);
    } else dir = join(this.root, scope);
    return this.inside(dir);
  }

  lessonsDir(scope: MemoryScope, ownerAgentId?: string | null): string {
    return join(this.scopeRoot(scope, ownerAgentId), "lessons");
  }

  pathFor(scope: MemoryScope, ownerAgentId: string | null, id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new ForerunnerError("validation", "lesson id is not a safe path segment", {
        details: { id },
      });
    }
    return this.inside(join(this.lessonsDir(scope, ownerAgentId), `${id}.md`));
  }

  /** The path a lesson's file must have; throws outside the root. */
  inside(p: string): string {
    const abs = resolve(p);
    if (!isInside(this.root, abs)) {
      throw new ForerunnerError("path_not_allowed", "path is outside the memory root", {
        details: { root: this.root, path: abs },
      });
    }
    return abs;
  }

  async write(doc: LessonDoc): Promise<string> {
    const problems = lintLesson(doc);
    if (problems.length) {
      throw new ForerunnerError("validation", `lesson fails lint: ${problems.join("; ")}`, {
        details: { id: doc.id, problems },
      });
    }
    const target = this.pathFor(doc.scope, doc.owner_agent_id, doc.id);
    await atomicWriteText(target, serializeLesson(doc));
    return target;
  }

  async read(path: string): Promise<LessonDoc> {
    const abs = this.inside(path);
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch (e) {
      throw new ForerunnerError(isMissing(e) ? "not_found" : "unavailable", errorMessage(e), {
        details: { path: abs },
        cause: e,
      });
    }
    const parsed = parseLesson(text);
    if (!parsed.ok) {
      throw new ForerunnerError("validation", `invalid lesson file: ${parsed.error}`, {
        details: { path: abs, error: parsed.error },
      });
    }
    return parsed.doc;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(this.inside(path));
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<boolean> {
    try {
      await fs.rm(this.inside(path));
      return true;
    } catch (e) {
      if (isMissing(e)) return false;
      throw e;
    }
  }

  /** Every lesson file of one scope root, sorted by id (ids are time-ordered). */
  async list(scope: MemoryScope, ownerAgentId?: string | null): Promise<ListResult> {
    const dir = this.lessonsDir(scope, ownerAgentId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if (isMissing(e)) return { lessons: [], invalid: [] };
      throw e;
    }
    const out: ListResult = { lessons: [], invalid: [] };
    for (const name of names.filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort()) {
      const path = join(dir, name);
      try {
        const doc = await this.read(path);
        const expected = `${doc.id}.md`;
        if (name !== expected) {
          out.invalid.push({ path, error: `file name ${name} does not match id ${doc.id}` });
          continue;
        }
        if (
          doc.scope !== scope ||
          (scope === "agent_private" && doc.owner_agent_id !== ownerAgentId)
        ) {
          out.invalid.push({ path, error: "lesson scope or owner does not match its directory" });
          continue;
        }
        out.lessons.push({ path, doc });
      } catch (e) {
        out.invalid.push({ path, error: errorMessage(e) });
      }
    }
    return out;
  }

  /**
   * Which embedder built this scope root's index (`<root>/index.json`). Null when the root has
   * never been reconciled. Vectors of different embedders are never compared (ADR 0002), and the
   * schema stores no embedder name per row, so `reconcile` compares against this marker and
   * re-embeds the whole root when it differs.
   */
  async readIndexMeta(scope: MemoryScope, ownerAgentId?: string | null): Promise<IndexMeta | null> {
    const p = join(this.scopeRoot(scope, ownerAgentId), INDEX_META_FILE);
    let text: string;
    try {
      text = await fs.readFile(p, "utf8");
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as IndexMeta).embedder === "string" &&
        typeof (parsed as IndexMeta).dims === "number" &&
        typeof (parsed as IndexMeta).format === "number"
      ) {
        const m = parsed as IndexMeta;
        return { embedder: m.embedder, dims: m.dims, format: m.format };
      }
    } catch {
      // fall through: an unreadable marker means "unknown embedder", which forces a re-embed
    }
    return null;
  }

  async writeIndexMeta(
    scope: MemoryScope,
    ownerAgentId: string | null | undefined,
    meta: IndexMeta,
  ): Promise<string> {
    const target = join(this.scopeRoot(scope, ownerAgentId), INDEX_META_FILE);
    await atomicWriteText(target, `${JSON.stringify(meta, null, 2)}\n`);
    return target;
  }

  /** The agent's standing notes; always loaded. Missing file reads as empty. */
  async readInstructions(ownerAgentId: string): Promise<string> {
    const p = join(this.scopeRoot("agent_private", ownerAgentId), "instructions.md");
    try {
      return normalizeNewlines(await fs.readFile(p, "utf8"));
    } catch (e) {
      if (isMissing(e)) return "";
      throw e;
    }
  }

  /** Generated map of one scope root for humans, grep and backups. Never agent-written. */
  async writeCatalog(scope: MemoryScope, ownerAgentId?: string | null): Promise<string> {
    const { lessons, invalid } = await this.list(scope, ownerAgentId);
    const lines = [
      `# Memory catalog: ${scope}${ownerAgentId ? ` (${ownerAgentId})` : ""}`,
      "",
      "Generated by Forerunner from the lesson files in `lessons/`. Edit the lesson files, not this table.",
      "",
      "| Lesson | Status | Tags | Confidence | Hits | Read if |",
      "| --- | --- | --- | --- | --- | --- |",
    ];
    for (const { doc } of lessons) {
      const readIf = doc.text.split("\n")[0]?.slice(0, 100).replace(/\|/g, "\\|") ?? "";
      lines.push(
        `| [${doc.id}](lessons/${doc.id}.md) | ${doc.status} | ${doc.tags.join(", ")} | ${doc.confidence} | ${doc.hit_count} | ${readIf} |`,
      );
    }
    if (invalid.length) {
      lines.push("", "## Files that failed to parse", "");
      for (const i of invalid) lines.push(`- ${basename(i.path)}: ${i.error}`);
    }
    const target = join(this.scopeRoot(scope, ownerAgentId), "catalog.md");
    await atomicWriteText(target, `${lines.join("\n")}\n`);
    return target;
  }
}

/** Row fields that must equal the file's; `embedding` and `file_path` are index data. */
function rowMatchesDoc(row: LessonRow, doc: LessonDoc, filePath: string, dims: number): boolean {
  return (
    row.scope === doc.scope &&
    row.owner_agent_id === doc.owner_agent_id &&
    row.project_id === doc.project_id &&
    row.text === doc.text &&
    row.source === doc.source &&
    JSON.stringify(row.tags) === JSON.stringify(doc.tags) &&
    row.confidence === doc.confidence &&
    row.last_used === doc.last_used &&
    row.hit_count === doc.hit_count &&
    row.superseded_by === doc.superseded_by &&
    row.pinned === doc.pinned &&
    row.status === doc.status &&
    row.created_at === doc.created_at &&
    row.updated_at === doc.updated_at &&
    row.author_agent === doc.author_agent &&
    row.author_human === doc.author_human &&
    row.version === doc.version &&
    row.file_path === filePath &&
    (row.embedding?.length ?? 0) === dims
  );
}

/** Insert or replace the index row so it equals the file exactly (version and timestamps too). */
export async function mirrorRow(
  repo: LessonStore,
  doc: LessonDoc,
  filePath: string,
  embedder: Embedder,
): Promise<LessonRow> {
  const embedding = vectorToJson(embedder.embed(doc.text));
  const fields = {
    scope: doc.scope,
    owner_agent_id: doc.owner_agent_id,
    project_id: doc.project_id,
    text: doc.text,
    source: doc.source,
    tags: doc.tags,
    confidence: doc.confidence,
    last_used: doc.last_used,
    hit_count: doc.hit_count,
    superseded_by: doc.superseded_by,
    pinned: doc.pinned,
    status: doc.status,
    author_agent: doc.author_agent,
    author_human: doc.author_human,
    embedding,
    file_path: filePath,
  };
  const existing = await repo.get(doc.id);
  if (existing) await repo.updateWhere(fields as Partial<LessonRow>, '"id" = ?', [doc.id]);
  else await repo.insert({ ...fields, id: doc.id, created_at: doc.created_at });
  await repo.overwriteEnvelope(doc.id, {
    version: doc.version,
    updated_at: doc.updated_at,
    created_at: doc.created_at,
  });
  return repo.mustGet(doc.id);
}

export interface ReconcileOptions {
  /** Delete rows whose file is gone instead of only reporting them. Default false. */
  deleteOrphans?: boolean;
  /** Regenerate the scope's catalog.md afterwards. Default true. */
  writeCatalog?: boolean;
}

export interface ReconcileReport {
  scope: MemoryScope;
  ownerAgentId: string | null;
  /** Rows created or replaced from a file. */
  upserted: string[];
  unchanged: string[];
  /** Rows with no file (or a file at another path); deleted only with `deleteOrphans`. */
  orphans: string[];
  /**
   * Files that failed to parse. They are never indexed; the valid files of the root are (a
   * deliberate deviation from ADR 0002's all-or-nothing load, recorded in ADR 0027). The runtime
   * raises its `memory.load_failed` diagnostic from this list and the catalog shows it.
   */
  invalid: { path: string; error: string }[];
  /** The embedder the index now carries; `reembedded` when every file was re-indexed for it. */
  embedder: { name: string; previous: string | null; reembedded: boolean };
}

/**
 * Rebuild the index of one scope root from its files: upsert rows for new or changed files,
 * re-embed, flag rows whose file is gone. Idempotent; heals a crash between a file write and
 * its row write. Private rows are only ever reconciled into the local store. When the root's
 * `index.json` names another embedder (or none), every file is re-embedded so that vectors of
 * two embedders never meet, whatever their width.
 */
export async function reconcile(
  files: LessonFiles,
  repo: LessonStore,
  embedder: Embedder,
  scope: MemoryScope,
  ownerAgentId: string | null = null,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const meta = await files.readIndexMeta(scope, ownerAgentId);
  const reembed =
    meta === null ||
    meta.embedder !== embedder.name ||
    meta.dims !== embedder.dims ||
    meta.format !== LESSON_FORMAT;
  const report: ReconcileReport = {
    scope,
    ownerAgentId: scope === "agent_private" ? ownerAgentId : null,
    upserted: [],
    unchanged: [],
    orphans: [],
    invalid: [],
    embedder: { name: embedder.name, previous: meta?.embedder ?? null, reembedded: reembed },
  };
  const listed = await files.list(scope, ownerAgentId);
  report.invalid = listed.invalid;
  const seen = new Set<string>();
  for (const { path, doc } of listed.lessons) {
    seen.add(doc.id);
    const row = await repo.get(doc.id);
    if (row && !reembed && rowMatchesDoc(row, doc, path, embedder.dims)) {
      report.unchanged.push(doc.id);
      continue;
    }
    await mirrorRow(repo, doc, path, embedder);
    report.upserted.push(doc.id);
  }
  if (reembed) {
    await files.writeIndexMeta(scope, ownerAgentId, {
      embedder: embedder.name,
      dims: embedder.dims,
      format: LESSON_FORMAT,
    });
  }
  const rows = await repo.list(
    scope === "agent_private" ? { scope, owner_agent_id: ownerAgentId } : { scope },
  );
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    report.orphans.push(row.id);
    if (opts.deleteOrphans) await repo.delete(row.id);
  }
  if (opts.writeCatalog !== false) await files.writeCatalog(scope, ownerAgentId);
  return report;
}

/** Row -> file, keeping flags the file already carries (the row has no flags column). */
export async function exportRow(
  files: LessonFiles,
  row: LessonRow,
  flags?: string[],
): Promise<string> {
  let keep = flags;
  if (keep === undefined) {
    keep = [];
    const p = files.pathFor(row.scope, row.owner_agent_id, row.id);
    if (await files.exists(p)) {
      try {
        keep = (await files.read(p)).flags;
      } catch {
        keep = [];
      }
    }
  }
  return files.write(rowToDoc(row, keep));
}
