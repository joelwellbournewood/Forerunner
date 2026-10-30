import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appDirs,
  basename,
  dirname,
  ForerunnerError,
  fromPosix,
  join,
  normalizeNewlines,
  relative,
  resolve,
  toPosix,
} from "@forerunner/platform";
import { parseFrontmatter } from "./frontmatter.ts";
import {
  CLAUDE_CODE_PREFIX,
  KNOWN_CLAUDE_CODE_TOOLS,
  type LoadedPrompt,
  type LoadRegistryOptions,
  NAME_RE,
  type PromptDef,
  PromptFrontmatterSchema,
  type Registry,
  type RegistryIssue,
  type SpecialistDef,
  SpecialistFrontmatterSchema,
} from "./types.ts";

export const SPECIALIST_FILE = "specialist.md";
export const SPECIALISTS_DIR = "specialists";
export const PROPOSED_DIR = "proposed";
export const PRINCIPALS_DIR = "principals";
export const CRITIC_FILE = "critic.md";
export const CRITIC_DIR = "critic";
export const EVALS_DIR = "evals";
export const DEFAULT_MAX_PROMPT_LINES = 120;

/**
 * sha256 of the text with line endings normalised and a leading UTF-8 BOM removed, exactly what
 * the parser sees; stable across Windows and Linux checkouts and editors that add a BOM.
 */
export function contentHash(text: string): string {
  return createHash("sha256")
    .update(normalizeNewlines(text.replace(/^﻿/, "")), "utf8")
    .digest("hex");
}

export function promptVersionOf(name: string, version: string, sha256: string): string {
  return `${name}@${version}+${sha256.slice(0, 8)}`;
}

/** Count eval task files (`NNN-<slug>.json`) in a directory; 0 when it does not exist. */
export function countEvalTasks(dir: string): number {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0;
  return readdirSync(dir).filter((f) => /^\d{3}-[a-z0-9-]+\.json$/.test(f)).length;
}

interface ReadResult<T> {
  def?: T;
  issues: RegistryIssue[];
}

function zodIssues(
  file: string,
  error: { issues: { path: PropertyKey[]; message: string }[] },
): RegistryIssue[] {
  return error.issues.map((i) => ({
    file,
    field: i.path.length ? i.path.map(String).join(".") : "-",
    message: i.message,
  }));
}

interface PromptText {
  parsed?: ReturnType<typeof parseFrontmatter>;
  loaded?: Omit<LoadedPrompt, "promptVersion">;
  issue?: RegistryIssue;
}

/** Parse file content that may or may not be on disk yet; `file` is where it lives or will live. */
function parsePromptText(text: string, file: string, relPath: string): PromptText {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(text, relPath);
  } catch (e) {
    return {
      issue: { file: relPath, field: "-", message: e instanceof Error ? e.message : String(e) },
    };
  }
  const sha256 = contentHash(text);
  const prompt = parsed.body;
  return {
    parsed,
    loaded: {
      file,
      relPath,
      sha256,
      sha8: sha256.slice(0, 8),
      prompt,
      promptLines: prompt === "" ? 0 : prompt.replace(/\n$/, "").split("\n").length,
    },
  };
}

function readPromptFile(file: string, registryDir: string): PromptText {
  const relPath = toPosix(relative(registryDir, file));
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return {
      issue: {
        file: relPath,
        field: "-",
        message: `cannot read file: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  return parsePromptText(text, file, relPath);
}

function checkTools(
  file: string,
  tools: readonly string[],
  opts: LoadRegistryOptions,
): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const cc = opts.claudeCodeTools ?? KNOWN_CLAUDE_CODE_TOOLS;
  tools.forEach((t, i) => {
    if (t.startsWith(CLAUDE_CODE_PREFIX)) {
      const bare = t.slice(CLAUDE_CODE_PREFIX.length);
      if (!cc.includes(bare)) {
        issues.push({
          file,
          field: `allowed_tools.${i}`,
          message: `unknown Claude Code tool "${t}"`,
        });
      }
    } else if (opts.toolNames && !opts.toolNames.includes(t)) {
      issues.push({ file, field: `allowed_tools.${i}`, message: `unknown Forerunner tool "${t}"` });
    }
  });
  const seen = new Set<string>();
  tools.forEach((t, i) => {
    if (seen.has(t))
      issues.push({ file, field: `allowed_tools.${i}`, message: `duplicate tool "${t}"` });
    seen.add(t);
  });
  return issues;
}

function checkPrompt(
  file: string,
  loaded: Omit<LoadedPrompt, "promptVersion">,
  opts: LoadRegistryOptions,
): RegistryIssue[] {
  const max = opts.maxPromptLines ?? DEFAULT_MAX_PROMPT_LINES;
  const issues: RegistryIssue[] = [];
  if (loaded.prompt.trim() === "")
    issues.push({ file, field: "prompt", message: "the role prompt (markdown body) is empty" });
  if (loaded.promptLines > max) {
    issues.push({
      file,
      field: "prompt",
      message: `prompt is ${loaded.promptLines} lines; the limit is ${max}`,
    });
  }
  return issues;
}

/** Read and validate one specialist file. Exported so tools that check one file can reuse it. */
export function readSpecialistFile(
  file: string,
  registryDir: string,
  location: "specialists" | "proposed",
  opts: LoadRegistryOptions = {},
): ReadResult<SpecialistDef> {
  return checkSpecialist(readPromptFile(file, registryDir), file, registryDir, location, opts);
}

/**
 * Validate specialist file content before it is written: the same checks `loadRegistry` applies
 * to `file` once it exists (frontmatter, schema, name/directory match, tools, prompt length).
 * `proposeSpecialist` runs this on the exact bytes it is about to write, so nothing invalid
 * reaches the disk.
 */
export function validateSpecialistText(
  text: string,
  file: string,
  registryDir: string,
  location: "specialists" | "proposed",
  opts: LoadRegistryOptions = {},
): ReadResult<SpecialistDef> {
  const relPath = toPosix(relative(registryDir, file));
  return checkSpecialist(parsePromptText(text, file, relPath), file, registryDir, location, opts);
}

function checkSpecialist(
  r: PromptText,
  file: string,
  registryDir: string,
  location: "specialists" | "proposed",
  opts: LoadRegistryOptions,
): ReadResult<SpecialistDef> {
  if (r.issue || !r.parsed || !r.loaded) return { issues: r.issue ? [r.issue] : [] };
  const relPath = r.loaded.relPath;
  const parsed = SpecialistFrontmatterSchema.safeParse(r.parsed.data);
  if (!parsed.success) return { issues: zodIssues(relPath, parsed.error) };
  const fm = parsed.data;
  const issues: RegistryIssue[] = [];
  const dirName = basename(dirname(file));
  if (fm.name !== dirName) {
    issues.push({
      file: relPath,
      field: "name",
      message: `name "${fm.name}" must match its directory "${dirName}"`,
    });
  }
  if (location === "proposed" && fm.status !== "proposed") {
    issues.push({
      file: relPath,
      field: "status",
      message: `files under ${PROPOSED_DIR}/ must have status "proposed"`,
    });
  }
  if (fm.eval_set !== `${EVALS_DIR}/${fm.name}`) {
    issues.push({
      file: relPath,
      field: "eval_set",
      message: `eval_set must be "${EVALS_DIR}/${fm.name}"`,
    });
  }
  issues.push(
    ...checkTools(relPath, fm.allowed_tools, opts),
    ...checkPrompt(relPath, r.loaded, opts),
  );
  if (issues.length) return { issues };
  const evalSetDir = join(registryDir, fromPosix(fm.eval_set));
  return {
    def: {
      ...fm,
      ...r.loaded,
      promptVersion: promptVersionOf(fm.name, fm.version, r.loaded.sha256),
      kind: "specialist",
      location,
      runnable: location === "specialists" && fm.status === "active",
      evalSetDir,
      evalTaskCount: countEvalTasks(evalSetDir),
    },
    issues: [],
  };
}

export function readPromptDefFile(
  file: string,
  registryDir: string,
  kind: "principal" | "critic",
  opts: LoadRegistryOptions = {},
): ReadResult<PromptDef> {
  const r = readPromptFile(file, registryDir);
  if (r.issue || !r.parsed || !r.loaded) return { issues: r.issue ? [r.issue] : [] };
  const relPath = r.loaded.relPath;
  const parsed = PromptFrontmatterSchema.safeParse(r.parsed.data);
  if (!parsed.success) return { issues: zodIssues(relPath, parsed.error) };
  const fm = parsed.data;
  const issues: RegistryIssue[] = [];
  const expected = basename(file, ".md");
  if (fm.name !== expected) {
    issues.push({
      file: relPath,
      field: "name",
      message: `name "${fm.name}" must match the file name "${expected}"`,
    });
  }
  issues.push(
    ...checkTools(relPath, fm.allowed_tools, opts),
    ...checkPrompt(relPath, r.loaded, opts),
  );
  if (issues.length) return { issues };
  return {
    def: {
      ...fm,
      ...r.loaded,
      promptVersion: promptVersionOf(fm.name, fm.version, r.loaded.sha256),
      kind,
    },
    issues: [],
  };
}

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/**
 * Load a registry directory. Every file is validated. Problems under `specialists/`,
 * `principals/` and `critic/` (committed, reviewed content) are collected and thrown together as
 * one `validation` error whose `details.issues` name the file and field. Problems under
 * `proposed/` (content written at runtime on an agent's request) are returned as
 * `invalidProposals` instead: the entry is left out, so a bad proposal can never take the other
 * specialists down or become runnable. In `principals/` only `<name>.md` files whose name matches
 * `NAME_RE` are prompts; anything else there (a README) is ignored.
 */
export function loadRegistry(dir: string, opts: LoadRegistryOptions = {}): Registry {
  const root = resolve(dir);
  const issues: RegistryIssue[] = [];
  const invalidProposals: RegistryIssue[] = [];
  const specialists = new Map<string, SpecialistDef>();
  const principals = new Map<string, PromptDef>();
  const files = new Map<string, string>();

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new ForerunnerError("not_found", `registry directory not found: ${root}`, {
      details: { dir: root },
    });
  }

  const specialistsRoot = join(root, SPECIALISTS_DIR);
  if (!existsSync(specialistsRoot)) {
    issues.push({ file: `${SPECIALISTS_DIR}/`, field: "-", message: "directory is missing" });
  }
  for (const location of [SPECIALISTS_DIR, PROPOSED_DIR] as const) {
    // specialists/ is strict; proposed/ is reported, never fatal.
    const sink = location === PROPOSED_DIR ? invalidProposals : issues;
    for (const name of listSubdirs(join(root, location))) {
      const file = join(root, location, name, SPECIALIST_FILE);
      const rel = `${location}/${name}/${SPECIALIST_FILE}`;
      if (!existsSync(file)) {
        sink.push({ file: rel, field: "-", message: `missing ${SPECIALIST_FILE}` });
        continue;
      }
      const r = readSpecialistFile(
        file,
        root,
        location === SPECIALISTS_DIR ? "specialists" : "proposed",
        opts,
      );
      sink.push(...r.issues);
      if (!r.def) continue;
      if (specialists.has(r.def.name)) {
        sink.push({
          file: rel,
          field: "name",
          message: `specialist "${r.def.name}" is already defined under ${specialists.get(r.def.name)?.location}/`,
        });
        continue;
      }
      specialists.set(r.def.name, r.def);
      files.set(r.def.relPath, r.def.sha256);
    }
  }

  const principalsRoot = join(root, PRINCIPALS_DIR);
  if (!existsSync(principalsRoot)) {
    issues.push({ file: `${PRINCIPALS_DIR}/`, field: "-", message: "directory is missing" });
  } else {
    for (const entry of readdirSync(principalsRoot)
      .filter((f) => f.endsWith(".md") && NAME_RE.test(basename(f, ".md")))
      .sort()) {
      const r = readPromptDefFile(join(principalsRoot, entry), root, "principal", opts);
      issues.push(...r.issues);
      if (!r.def) continue;
      principals.set(r.def.name, r.def);
      files.set(r.def.relPath, r.def.sha256);
    }
    if (principals.size === 0 && !issues.some((i) => i.file.startsWith(`${PRINCIPALS_DIR}/`))) {
      issues.push({ file: `${PRINCIPALS_DIR}/`, field: "-", message: "no principal prompt found" });
    }
  }

  let critic: PromptDef | undefined;
  const criticFile = join(root, CRITIC_DIR, CRITIC_FILE);
  if (!existsSync(criticFile)) {
    issues.push({ file: `${CRITIC_DIR}/${CRITIC_FILE}`, field: "-", message: "file is missing" });
  } else {
    const r = readPromptDefFile(criticFile, root, "critic", opts);
    issues.push(...r.issues);
    if (r.def) {
      critic = r.def;
      files.set(r.def.relPath, r.def.sha256);
    }
  }

  if (issues.length > 0 || !critic) {
    const summary = issues
      .slice(0, 12)
      .map((i) => `${i.file} [${i.field}]: ${i.message}`)
      .join("; ");
    throw new ForerunnerError(
      "validation",
      `registry at ${root} has ${issues.length} problem(s): ${summary}${issues.length > 12 ? "; ..." : ""}`,
      { details: { dir: root, issues } },
    );
  }

  const sortedFiles = new Map(
    [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const hash = createHash("sha256")
    .update([...sortedFiles.entries()].map(([p, h]) => `${p}:${h}`).join("\n"), "utf8")
    .digest("hex");
  const criticDef = critic;

  return {
    dir: root,
    specialists,
    principals,
    critic: criticDef,
    invalidProposals,
    files: sortedFiles,
    hash,
    version(name: string): string {
      const def =
        specialists.get(name) ??
        principals.get(name) ??
        (criticDef.name === name ? criticDef : undefined);
      if (!def)
        throw new ForerunnerError("not_found", `no registry entry named "${name}"`, {
          details: { name },
        });
      return def.promptVersion;
    },
    specialist(name: string): SpecialistDef {
      const def = specialists.get(name);
      if (!def)
        throw new ForerunnerError("not_found", `no specialist named "${name}"`, {
          details: { name },
        });
      return def;
    },
    runnableSpecialists(): SpecialistDef[] {
      return [...specialists.values()]
        .filter((s) => s.runnable)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

export type RegistrySource = "env" | "repo" | "bundled" | "app";

export interface ResolvedRegistryDir {
  dir: string;
  source: RegistrySource;
  /**
   * `bundled`: the registry the desktop installer carries, read-only where the app is installed;
   * `seedRegistry(seed, dir)` copies it into the writable `dir` at start (ADR 0092).
   */
  seed?: string;
}

/**
 * The file the runtime payload of the desktop installers carries at its root
 * (`scripts/build-runtime-payload.mjs`, ADR 0092). A checkout with it is an installed app, not a
 * development checkout: its directory may be read-only (Program Files, /usr/lib).
 */
export const BUNDLED_RUNTIME_MARKER = "runtime.json";
/** In a seeded registry: the bundle's files as of the last seeding, so a dropped one is removed. */
export const SEED_MANIFEST = ".bundled.json";

export interface ResolveRegistryOptions {
  /** Where to start the upward search for a repository checkout. Default: this file's directory. */
  startDir?: string;
  /** Injected for tests. */
  exists?: (p: string) => boolean;
  /** Upward search depth. Default 8. */
  maxDepth?: number;
}

/** Marker that identifies a repository checkout holding the local registry copy. */
export const REPO_REGISTRY_MARKER = join(EVALS_DIR, "registry", SPECIALISTS_DIR);

/**
 * Where the registry lives, in order: `FORERUNNER_REGISTRY_DIR`; the checkout's `evals/registry`
 * when the runtime runs from the repository; `appDirs().data/registry` seeded from the
 * installer's copy when the runtime is the one a desktop installer carries (the checkout has
 * `runtime.json`; proposals and promotions write into the registry, and the install directory
 * is read-only); otherwise `appDirs().data/registry` as it is.
 */
export function resolveRegistryDir(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveRegistryOptions = {},
): ResolvedRegistryDir {
  const override = env.FORERUNNER_REGISTRY_DIR;
  if (override?.trim()) return { dir: resolve(override.trim()), source: "env" };
  const exists = opts.exists ?? existsSync;
  let current = opts.startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < (opts.maxDepth ?? 8); depth++) {
    if (exists(join(current, REPO_REGISTRY_MARKER))) {
      const seed = join(current, EVALS_DIR, "registry");
      if (exists(join(current, BUNDLED_RUNTIME_MARKER))) {
        return { dir: join(appDirs({ env }).data, "registry"), source: "bundled", seed };
      }
      return { dir: seed, source: "repo" };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { dir: join(appDirs({ env }).data, "registry"), source: "app" };
}

export interface SeedReport {
  copied: number;
  removed: number;
}

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, fromPosix(rel)), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

/**
 * Copy the installer's registry (`seed`) into the writable `dir` (ADR 0092). Every file of the
 * seed is written, so a new release's prompts and specialists replace the old ones; files that
 * exist only in `dir` (proposals under `proposed/`, promoted specialists, which the registry
 * only ever adds) are kept; a file an earlier seed brought and this one no longer has is
 * removed (`SEED_MANIFEST` lists the last seed's files). Paths in the manifest are POSIX.
 */
export function seedRegistry(seed: string, dir: string): SeedReport {
  const files = listFiles(seed)
    .filter((f) => f !== SEED_MANIFEST)
    .sort();
  const manifestPath = join(dir, SEED_MANIFEST);
  let previous: string[] = [];
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: unknown };
      if (Array.isArray(parsed.files)) {
        previous = parsed.files.filter((f): f is string => typeof f === "string");
      }
    } catch {
      previous = [];
    }
  }
  for (const rel of files) {
    const target = join(dir, fromPosix(rel));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(seed, fromPosix(rel)), target);
  }
  const current = new Set(files);
  let removed = 0;
  for (const rel of previous) {
    // Only names the seed brought, never one that walks out of the registry.
    if (current.has(rel) || rel.split("/").includes("..") || rel.startsWith("/")) continue;
    const target = join(dir, fromPosix(rel));
    if (existsSync(target)) {
      rmSync(target, { force: true });
      removed++;
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify({ schema: 1, files }, null, 2)}\n`);
  return { copied: files.length, removed };
}
