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
      `# ${p.name}\n\n${p.goal ?? "Goal: to be written."}\n\n## Run\n\nTo be written.\n\n## Docs\n\nSee \`docs/overview.md\`, \`docs/architecture.md\`, \`docs/status.md\`, \`docs/decisions/\`, \`docs/runbook.md\`, \`docs/data.md\`, \`docs/testing.md\`.\n`,
  },
  "docs/overview.md": {
    readIf: "You need the goal, the users and the scope of the project in one page",
    body: (p) =>
      `# Overview\n\n## Goal\n\n${p.goal ?? "To be written."}\n\n## Users\n\nTo be written.\n\n## Scope\n\nIn scope: to be written. Out of scope: to be written.\n`,
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

function frontmatter(readIf: string): string {
  return `---\nmaintained-by: ${MAINTAINED_BY}\nread_if: ${JSON.stringify(readIf)}\n---\n`;
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
    const t = TEMPLATES[doc];
    await fs.mkdir(join(repoDir, fromPosix(rel.slice(0, rel.lastIndexOf("/") + 1) || ".")), {
      recursive: true,
    });
    await fs.writeFile(abs, `${frontmatter(t.readIf)}${t.body(project)}`, "utf8");
    out.created.push(rel);
  }
  return out;
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
