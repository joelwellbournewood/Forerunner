import * as fs from "node:fs/promises";
import { fromPosix, join, normalizeNewlines, toPosix } from "@forerunner/platform";

/**
 * The standard project doc set (spec G): kept in git, maintained by the PM at session end,
 * drift checked by the critic at tier 2+. This module scaffolds missing docs from templates and
 * says which docs a change should have touched. It never edits an existing doc.
 */

export const STANDARD_DOCS = [
  "README.md",
  "docs/overview.md",
  "docs/architecture.md",
  "docs/status.md",
  "docs/decisions/",
  "docs/runbook.md",
  "docs/data.md",
  "docs/testing.md",
] as const;

export type StandardDoc = (typeof STANDARD_DOCS)[number];

export const MAINTAINED_BY = "forerunner";

export interface ProjectInfo {
  name: string;
  goal?: string;
  repos?: string[];
}

export interface ScaffoldResult {
  created: string[];
  existing: string[];
}

interface DocTemplate {
  readIf: string;
  body: (p: ProjectInfo) => string;
}

const TEMPLATES: Record<StandardDoc, DocTemplate> = {
  "README.md": {
    readIf: "You are new to the project and need to know what it is and how to run it",
    body: (p) =>
      `# ${p.name}\n\n${p.goal ?? "Goal: to be written."}\n\n## Run\n\nTo be written.\n${reposSection(p)}\n## Docs\n\nSee \`docs/overview.md\`, \`docs/architecture.md\`, \`docs/status.md\`, \`docs/decisions/\`, \`docs/runbook.md\`, \`docs/data.md\`, \`docs/testing.md\`.\n`,
  },
  "docs/overview.md": {
    readIf: "You need the goal, the users and the scope of the project in one page",
    body: (p) =>
      `# Overview\n\n## Goal\n\n${p.goal ?? "To be written."}\n\n## Users\n\nTo be written.\n\n## Scope\n\nIn scope: to be written. Out of scope: to be written.\n${reposSection(p)}`,
  },
  "docs/architecture.md": {
    readIf: "You are changing the code layout, a component boundary or a data flow",
    body: () =>
      "# Architecture\n\n## Components\n\nTo be written: one line per component and what it owns.\n\n## Layout\n\nTo be written: the source tree and what lives where.\n\n## Data flow\n\nTo be written.\n",
  },
  "docs/status.md": {
    readIf: "You want to know what is done, in flight, blocked and next",
    body: () =>
      "# Status\n\n## Done\n\n- nothing yet\n\n## In flight\n\n- nothing yet\n\n## Blocked\n\n- nothing\n\n## Next\n\n- first task\n",
  },
  "docs/decisions/": {
    readIf: "You are about to make or question a non-obvious design choice",
    body: () =>
      "# Decisions\n\nOne file per non-obvious decision: `NNNN-title.md`, numbered, never edited after acceptance except to mark it superseded.\n\nTemplate:\n\n```\n# NNNN — Title\n\nDate: YYYY-MM-DD\nStatus: accepted | superseded by NNNN\n\n## Context\n## Decision\n## Consequences\n## Alternatives considered\n```\n\n| ADR | Title |\n| --- | --- |\n",
  },
  "docs/runbook.md": {
    readIf: "Something is broken in a running install or a deploy is due",
    body: () =>
      "# Runbook\n\n## Start and stop\n\nTo be written.\n\n## Deploy\n\nTo be written.\n\n## Common failures\n\n| Symptom | Cause | Fix |\n| --- | --- | --- |\n",
  },
  "docs/data.md": {
    readIf: "You are touching storage, a schema, a migration or a data asset",
    body: () =>
      "# Data\n\n## Stores\n\nTo be written: every store, what it holds, where it lives.\n\n## Schema\n\nTo be written.\n\n## Migrations\n\nTo be written.\n",
  },
  "docs/testing.md": {
    readIf: "You are adding tests or the test command changed",
    body: () =>
      "# Testing\n\n## Commands\n\nTo be written.\n\n## Layers\n\nUnit, integration, end to end: to be written.\n\n## Fixtures and stand-ins\n\nTo be written.\n",
  },
};

/** A "## Repositories" section listing the project's repos, or nothing without any. */
function reposSection(p: ProjectInfo): string {
  const repos = (p.repos ?? []).map((r) => r.trim()).filter(Boolean);
  if (!repos.length) return "";
  return `\n## Repositories\n\n${repos.map((r) => `- ${r}`).join("\n")}\n`;
}

function frontmatter(readIf: string): string {
  return `---\nmaintained-by: ${MAINTAINED_BY}\nread_if: ${JSON.stringify(readIf)}\n---\n`;
}

/** The full text (frontmatter and body) a standard doc is scaffolded with. */
export function renderStandardDoc(doc: StandardDoc, project: ProjectInfo): string {
  const t = TEMPLATES[doc];
  return `${frontmatter(t.readIf)}${t.body(project)}`;
}

/** Repo-relative file path of a standard doc entry (directories map to their README). */
export function docFile(doc: StandardDoc): string {
  return doc.endsWith("/") ? `${doc}README.md` : doc;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Write every missing standard doc from its template; existing files are never touched. */
export async function scaffoldDocs(repoDir: string, project: ProjectInfo): Promise<ScaffoldResult> {
  const out: ScaffoldResult = { created: [], existing: [] };
  for (const doc of STANDARD_DOCS) {
    const rel = docFile(doc);
    const abs = join(repoDir, fromPosix(rel));
    if (await exists(abs)) {
      out.existing.push(rel);
      continue;
    }
    await fs.mkdir(join(repoDir, fromPosix(rel.slice(0, rel.lastIndexOf("/") + 1) || ".")), {
      recursive: true,
    });
    await fs.writeFile(abs, renderStandardDoc(doc, project), "utf8");
    out.created.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// docs/status.md: the PM's session-end update (spec G.5 "PM keeps them current")
// ---------------------------------------------------------------------------------------

export const STATUS_DOC = "docs/status.md";

/** The four sections the PM rewrites at every session end, in the template's order. */
export const STATUS_SECTIONS = ["Done", "In flight", "Blocked", "Next"] as const;

export const SESSIONS_HEADING = "Sessions";

/** Session entries kept under "## Sessions" (newest first); older ones drop off. */
export const MAX_STATUS_SESSIONS = 20;

/** One line per title in the doc; longer titles are cut with an ellipsis. */
const STATUS_TITLE_MAX = 120;

export interface StatusLists {
  done: string[];
  inFlight: string[];
  blocked: string[];
  next: string[];
}

/** What a session reports into `docs/status.md` at its end. */
export interface StatusUpdate extends StatusLists {
  sessionId: string;
  /** ISO-8601 UTC instant the session ended (from the Clock); the entry is dated by it. */
  endedAt: string;
  /** One line for the session entry: the stop reason, the spend. */
  note?: string;
  /**
   * The project's current state for the four top sections (every open task, not only this
   * session's). Defaults to the session's own lists.
   */
  state?: StatusLists;
}

export interface StatusWriteResult {
  /** Repo-relative POSIX path of the doc. */
  path: string;
  /** True when the doc did not exist and was scaffolded first. */
  created: boolean;
  content: string;
}

interface DocSection {
  /** The H2 heading text without "## ", or null for the preamble before the first H2. */
  heading: string | null;
  lines: string[];
}

function oneLine(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length > STATUS_TITLE_MAX ? `${t.slice(0, STATUS_TITLE_MAX).trimEnd()}...` : t;
}

function bullets(items: string[], empty: string): string[] {
  const lines = items.map(oneLine).filter(Boolean);
  return lines.length ? lines.map((l) => `- ${l}`) : [`- ${empty}`];
}

function joined(items: string[]): string {
  const lines = items.map(oneLine).filter(Boolean);
  return lines.length ? lines.join("; ") : "none";
}

/** Split a markdown doc into its preamble and H2 sections (frontmatter stays in the preamble). */
function splitSections(text: string): DocSection[] {
  const lines = normalizeNewlines(text).split("\n");
  const out: DocSection[] = [{ heading: null, lines: [] }];
  let i = 0;
  // Frontmatter is part of the preamble; its lines never start a section.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      out[0]?.lines.push(...lines.slice(0, end + 1));
      i = end + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) out.push({ heading: m[1], lines: [] });
    else out[out.length - 1]?.lines.push(line);
  }
  return out;
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
}

function sectionText(s: DocSection): string {
  const body = trimBlank(s.lines);
  const head = s.heading === null ? [] : [`## ${s.heading}`];
  if (!body.length) return head.length ? `${head[0]}\n` : "";
  return `${[...head, ...(head.length ? [""] : []), ...body].join("\n")}\n`;
}

/** The "### <date> session <id>" entry for one session. */
function sessionEntry(u: StatusUpdate): string[] {
  const lines = [
    `### ${u.endedAt.slice(0, 10)} session ${oneLine(u.sessionId)}`,
    "",
    `- Done: ${joined(u.done)}`,
    `- In flight: ${joined(u.inFlight)}`,
    `- Blocked: ${joined(u.blocked)}`,
    `- Next: ${joined(u.next)}`,
  ];
  if (u.note?.trim()) lines.push(`- Note: ${oneLine(u.note)}`);
  return lines;
}

/** Entries of the Sessions section, each starting at its "### " heading. */
function splitEntries(lines: string[]): string[][] {
  const entries: string[][] = [];
  for (const line of lines) {
    if (/^###\s/.test(line)) entries.push([line]);
    else entries[entries.length - 1]?.push(line);
  }
  return entries.map(trimBlank).filter((e) => e.length);
}

/**
 * The next text of `docs/status.md` after a session: the four standard sections rewritten
 * from the update (the project state when given, else the session's lists), every other
 * section and the frontmatter kept as they are, sections the doc lacks added before the
 * session log, and a dated entry for the session put first under "## Sessions" (an entry
 * for the same session id is replaced, so a rerun changes nothing; the log keeps the newest
 * `MAX_STATUS_SESSIONS`). A missing doc starts from the template.
 */
export function applyStatusUpdate(existing: string | null, update: StatusUpdate): string {
  const sections = splitSections(existing ?? renderStandardDoc("docs/status.md", { name: "" }));
  const lists = update.state ?? update;
  const content: Record<(typeof STATUS_SECTIONS)[number], string[]> = {
    Done: bullets(lists.done, "nothing"),
    "In flight": bullets(lists.inFlight, "nothing"),
    Blocked: bullets(lists.blocked, "nothing"),
    Next: bullets(lists.next, "nothing"),
  };
  const key = (h: string) => STATUS_SECTIONS.find((s) => s.toLowerCase() === h.toLowerCase());
  const seen = new Set<string>();
  let sessions: DocSection | null = null;
  const kept: DocSection[] = [];
  for (const s of sections) {
    if (s.heading !== null && s.heading.toLowerCase() === SESSIONS_HEADING.toLowerCase()) {
      sessions = s;
      continue;
    }
    const k = s.heading === null ? undefined : key(s.heading);
    if (k) {
      seen.add(k);
      kept.push({ heading: k, lines: content[k] });
    } else kept.push(s);
  }
  for (const k of STATUS_SECTIONS) if (!seen.has(k)) kept.push({ heading: k, lines: content[k] });
  const mine = sessionEntry(update);
  const others = splitEntries(sessions?.lines ?? []).filter((e) => e[0] !== mine[0]);
  const entries = [mine, ...others].slice(0, MAX_STATUS_SESSIONS);
  kept.push({
    heading: SESSIONS_HEADING,
    lines: entries.flatMap((e, i) => (i ? ["", ...e] : e)),
  });
  return kept.map(sectionText).filter(Boolean).join("\n");
}

/**
 * Write the session's update into `<repoDir>/docs/status.md`, scaffolding the doc from its
 * template first when the repo has none. No other doc is touched.
 */
export async function writeStatusUpdate(
  repoDir: string,
  update: StatusUpdate,
): Promise<StatusWriteResult> {
  const abs = join(repoDir, fromPosix(STATUS_DOC));
  let existing: string | null = null;
  try {
    existing = await fs.readFile(abs, "utf8");
  } catch {
    existing = null;
  }
  const content = applyStatusUpdate(existing, update);
  await fs.mkdir(join(repoDir, fromPosix("docs")), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return { path: STATUS_DOC, created: existing === null, content };
}

/** The `key: value` frontmatter of a doc, or an empty object when it has none. */
export function parseDocFrontmatter(text: string): Record<string, string> {
  const t = normalizeNewlines(text);
  if (!t.startsWith("---\n")) return {};
  const end = t.indexOf("\n---\n", 4);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of t.slice(4, end).split("\n")) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        // keep raw
      }
    }
    out[m[1] as string] = v;
  }
  return out;
}

export type ChangeKind = "added" | "modified" | "removed";

export interface ChangedFile {
  /** Repo-relative path, either separator. */
  path: string;
  kind?: ChangeKind;
}

export interface DriftCheckInput {
  /** Files changed since the last session (a string means `modified`). */
  changedFiles: (string | ChangedFile)[];
  /** Any task changed state during the session. */
  tasksChanged?: boolean;
  /** Set (optionally to the reason) when the session made an ADR-worthy choice. */
  adrWorthy?: boolean | string;
}

export interface DocDrift {
  doc: string;
  reason: string;
}

const LAYOUT_DIR = /(^|\/)(src|lib|app|apps|packages|services|cmd|internal)\//;
const DATA_FILE = /(^|\/)(schema|migrations?|models?)([./]|$)|\.sql$|\bprisma\b/i;
const TEST_INFRA =
  /(^|\/)(vitest|jest|pytest|playwright)\.config\.|(^|\/)\.github\/workflows\/|(^|\/)(conftest\.py|pytest\.ini|setup\.cfg)$/;

/**
 * Which standard docs this change should have touched, for the critic:
 * - `docs/status.md` after any task change or any non-doc file change;
 * - `docs/architecture.md` when the source layout changed (files added or removed under a
 *   source directory);
 * - `docs/decisions/` when an ADR-worthy change is flagged and no decision file changed;
 * - `docs/data.md` when schema, migration or model files changed;
 * - `docs/testing.md` when test infrastructure changed;
 * - any standard doc that is missing from the repo.
 */
export async function checkDocDrift(repoDir: string, input: DriftCheckInput): Promise<DocDrift[]> {
  const changes: { path: string; kind: ChangeKind }[] = input.changedFiles.map((c) =>
    typeof c === "string"
      ? { path: toPosix(c).replace(/^\.\//, ""), kind: "modified" as const }
      : { path: toPosix(c.path).replace(/^\.\//, ""), kind: c.kind ?? ("modified" as const) },
  );
  const touched = new Set(changes.map((c) => c.path));
  const isDoc = (p: string) => p === "README.md" || p.startsWith("docs/");
  const drift: DocDrift[] = [];
  const expect = (doc: string, reason: string) => {
    const satisfied = doc.endsWith("/")
      ? [...touched].some((p) => p.startsWith(doc))
      : touched.has(doc);
    if (!satisfied) drift.push({ doc, reason });
  };

  const codeChanged = changes.filter((c) => !isDoc(c.path));
  if (input.tasksChanged || codeChanged.length) {
    expect(
      "docs/status.md",
      input.tasksChanged ? "a task changed state" : `${codeChanged.length} non-doc file(s) changed`,
    );
  }
  const layout = codeChanged.filter((c) => c.kind !== "modified" && LAYOUT_DIR.test(c.path));
  if (layout.length) {
    expect(
      "docs/architecture.md",
      `source layout changed: ${layout
        .slice(0, 3)
        .map((c) => `${c.kind} ${c.path}`)
        .join(", ")}${layout.length > 3 ? ", ..." : ""}`,
    );
  }
  if (input.adrWorthy) {
    expect(
      "docs/decisions/",
      typeof input.adrWorthy === "string" ? input.adrWorthy : "an ADR-worthy change was flagged",
    );
  }
  const data = codeChanged.filter((c) => DATA_FILE.test(c.path));
  if (data.length) expect("docs/data.md", `data files changed: ${data[0]?.path}`);
  const testInfra = codeChanged.filter((c) => TEST_INFRA.test(c.path));
  if (testInfra.length)
    expect("docs/testing.md", `test infrastructure changed: ${testInfra[0]?.path}`);

  for (const doc of STANDARD_DOCS) {
    if (!(await exists(join(repoDir, fromPosix(docFile(doc)))))) {
      drift.push({ doc, reason: "missing from the standard doc set" });
    }
  }
  return drift;
}
