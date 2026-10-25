import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fromPosix, join, normalizeNewlines } from "@forerunner/platform";

/**
 * The install marker (spec A.4, ADR 0056 point 4): `.forerunner/project.json` at the root of
 * a repository or workspace Forerunner manages, so a source scan by any install tells a
 * managed repository or folder from a fresh one. The G.5 docs scaffold writes it beside the
 * doc set (ADR 0058, amendment of 2026-10-25), on the same branch and pull request for a
 * repository and in the workspace without one; the scan (`discovery.ts`) reads it on the
 * default branch, so a repository shows as an install once the scaffold's pull request is
 * merged. The file names the project on the install that wrote it; it is never overwritten
 * with another project's.
 */
export const INSTALL_MARKER_FILE = ".forerunner/project.json";

export const INSTALL_MARKER_SCHEMA = 1;

export interface InstallMarker {
  schema: typeof INSTALL_MARKER_SCHEMA;
  /** The project id on the install that wrote the marker. */
  project: string;
  /** The project's name when the marker was written; for a human reading the file. */
  name: string;
}

/** What `writeInstallMarker` did; `path` is the repo-relative POSIX path of the marker. */
export type InstallMarkerWrite =
  | { path: string; status: "created" | "kept" }
  | { path: string; status: "other_project"; project: string | null };

/** The marker's text: pretty JSON with a trailing newline, stable for a diff. */
export function renderInstallMarker(m: { project: string; name: string }): string {
  const marker: InstallMarker = { schema: INSTALL_MARKER_SCHEMA, project: m.project, name: m.name };
  return `${JSON.stringify(marker, null, 2)}\n`;
}

/**
 * The marker a file holds, or null when the text is not one this schema wrote (bad JSON,
 * another schema, no project id). A hand-written `{}` is a marker to the scan (it exists) but
 * names no project here.
 */
export function parseInstallMarker(text: string): InstallMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(normalizeNewlines(text));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.schema !== INSTALL_MARKER_SCHEMA) return null;
  if (typeof o.project !== "string" || !o.project) return null;
  return {
    schema: INSTALL_MARKER_SCHEMA,
    project: o.project,
    name: typeof o.name === "string" ? o.name : "",
  };
}

/**
 * Write the marker under `dir` unless one is there already: this project's is kept as it is
 * (`kept`); one of another project, or a file that is not a marker of this schema, is reported
 * (`other_project`, with the id it names or null) and never overwritten.
 */
export async function writeInstallMarker(
  dir: string,
  m: { project: string; name: string },
): Promise<InstallMarkerWrite> {
  const abs = join(dir, fromPosix(INSTALL_MARKER_FILE));
  let existing: string | null = null;
  try {
    existing = await readFile(abs, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== null) {
    const parsed = parseInstallMarker(existing);
    if (parsed?.project === m.project) return { path: INSTALL_MARKER_FILE, status: "kept" };
    return { path: INSTALL_MARKER_FILE, status: "other_project", project: parsed?.project ?? null };
  }
  await mkdir(join(dir, ".forerunner"), { recursive: true });
  await writeFile(abs, renderInstallMarker(m), "utf8");
  return { path: INSTALL_MARKER_FILE, status: "created" };
}
