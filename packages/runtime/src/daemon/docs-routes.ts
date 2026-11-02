import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { docFile, STANDARD_DOCS } from "@forerunner/memory";
import {
  basename,
  errorMessage,
  ForerunnerError,
  fromPosix,
  isInside,
  isWindows,
  join,
  log,
} from "@forerunner/platform";
import type { ProjectRow, StateStore } from "@forerunner/state";
import { Hono } from "hono";
import { type DocInPullRequest, WORKSPACE_DIR } from "../loop/docs.ts";
import type {
  DocContentView,
  DocView,
  ProjectFileContentView,
  ProjectFileEntryView,
  ProjectFilesView,
  ProjectPullRequestsView,
} from "./api-types.ts";
import { ownsProject, type Who } from "./ownership.ts";
import { reviewsView } from "./views.ts";

/**
 * The Docs tab (spec G.5, K.2; U-005 in docs/status/UPDATE-LOG.md): the standard doc set of a
 * project as this install has it, and one doc's text. The roots are `ProjectDocs.docsDirsFor`
 * in its order (a linked local folder, this install's docs clone of the repository, the
 * project's workspace), the same the chat's docs search reads; nothing is cloned for it, so
 * a repository's docs show as this install last wrote or pulled them (its default branch, ADR
 * 0106), and a doc missing there that waits in one of Forerunner's docs pull requests says so
 * with the PR (`docsInPullRequests`, which fetches). A doc's drift is an open critic finding
 * that names it.
 */
export interface DocsRoutesDeps {
  store: StateStore;
  /** The roots a project's docs are read from (`ProjectDocs.docsDirsFor`). */
  docsDirsFor: (project: ProjectRow) => string[];
  /** The docs that wait in a docs pull request (`ProjectDocs.docsInPullRequests`). */
  docsInPullRequests?: (project: ProjectRow) => Promise<DocInPullRequest[]>;
  /** A repository project's pull requests that wait for the person (`projectPullRequests`). */
  pullRequests?: (project: ProjectRow) => Promise<ProjectPullRequestsView>;
  who: () => Who;
}

const logger = log("docs-routes");

/** The largest doc `GET /projects/:id/docs/:path` returns in full; longer ones are cut. */
export const DOC_CONTENT_MAX_BYTES = 512 * 1024;

const TITLES: Record<(typeof STANDARD_DOCS)[number], string> = {
  "README.md": "Readme",
  "docs/overview.md": "Overview",
  "docs/architecture.md": "Architecture",
  "docs/status.md": "Status",
  "docs/decisions/": "Decisions",
  "docs/runbook.md": "Runbook",
  "docs/data.md": "Data",
  "docs/testing.md": "Testing",
};

interface Located {
  root: string;
  file: string;
  sizeBytes: number;
  updatedAt: string;
}

/** The first root holding the file, with its size and modification time. */
function locate(roots: string[], rel: string): Located | null {
  for (const root of roots) {
    const file = join(root, fromPosix(rel));
    try {
      const st = statSync(file);
      if (st.isFile()) {
        return { root, file, sizeBytes: st.size, updatedAt: st.mtime.toISOString() };
      }
    } catch {
      // not in this root
    }
  }
  return null;
}

/** Where a doc was read from, in the words the tab shows (the roots of `docsDirsFor`). */
function rootLabel(project: ProjectRow, root: string): string {
  if (root === project.repos[0]?.trim()) return "from the linked folder";
  if (basename(root) === WORKSPACE_DIR) return "from the project folder";
  return "from this PC's copy of the repository";
}

/** A decision record of the project (`docs/decisions/0001-title.md`): Docs opens it. */
export const DECISION_RECORD = /^docs\/decisions\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/** Folders the Files tab does not list: version control, dependencies, the install marker. */
export const FILES_SKIPPED = new Set([".git", "node_modules", ".forerunner"]);
/** At most this many entries are listed (`truncated` says when there were more). */
export const FILES_MAX_ENTRIES = 2000;
const FILES_MAX_DEPTH = 8;

/**
 * The project's files under its folder (design §3.10): every file and folder, depth first in
 * name order, with sizes and change dates, without following links out of it.
 */
export function listProjectFiles(root: string): {
  entries: ProjectFileEntryView[];
  truncated: boolean;
} {
  const entries: ProjectFileEntryView[] = [];
  let truncated = false;
  const walk = (dir: string, prefix: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const name of names) {
      if (FILES_SKIPPED.has(name)) continue;
      if (entries.length >= FILES_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const full = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (st.isDirectory()) {
        entries.push({ path, kind: "dir", sizeBytes: 0, updatedAt: st.mtime.toISOString() });
        if (depth < FILES_MAX_DEPTH) walk(full, path, depth + 1);
      } else if (st.isFile()) {
        entries.push({
          path,
          kind: "file",
          sizeBytes: st.size,
          updatedAt: st.mtime.toISOString(),
        });
      }
    }
  };
  walk(root, "", 0);
  return { entries, truncated };
}

/** Windows' device names, which name no file in any folder ("CON", "nul.txt", "COM1.md"). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * A segment Windows reads as something else than a file of the folder: an alternate data
 * stream ("a.txt:hidden", a colon is no letter of a Windows file name) or a device name.
 */
function notAWindowsFileName(segment: string): boolean {
  return segment.includes(":") || WINDOWS_DEVICE.test(segment);
}

/**
 * The file a relative path names under the root, or null when the path leaves it: an absolute
 * path, a drive, a `..` segment, a skipped folder, or a link that resolves outside the root.
 */
export function fileUnder(root: string, rel: string): string | null {
  const parts = rel.replace(/\\/g, "/").split("/");
  if (
    rel.length === 0 ||
    rel.startsWith("/") ||
    /^[A-Za-z]:/.test(rel) ||
    parts.some((p) => p === "" || p === "." || p === ".." || FILES_SKIPPED.has(p)) ||
    (isWindows() && parts.some(notAWindowsFileName))
  )
    return null;
  const file = join(root, ...parts);
  try {
    const real = realpathSync(file);
    if (!isInside(realpathSync(root), real)) return null;
    return real;
  } catch {
    return null;
  }
}

/** The largest file `GET /projects/:id/files/:path` shows inline; longer ones are cut. */
export const FILE_CONTENT_MAX_BYTES = 256 * 1024;

export function createDocsRoutes(deps: DocsRoutesDeps): Hono {
  const app = new Hono();

  const owned = async (id: string) => {
    const project = await deps.store.project.mustGet(id);
    return ownsProject(project, deps.who()) ? project : null;
  };

  app.get("/projects/:id/docs", async (c) => {
    const project = await owned(c.req.param("id"));
    if (!project) return c.json({ code: "forbidden", message: "not your project" }, 403);
    const roots = deps.docsDirsFor(project);
    const reviews = await reviewsView(deps.store, { projectId: project.id, limit: 50 });
    // Before (GitHub walk, 2026-11-02) the docs read "missing · not written yet" while they
    // waited in the scaffold's pull request #1, which nothing showed.
    let waiting: DocInPullRequest[] = [];
    try {
      waiting = (await deps.docsInPullRequests?.(project)) ?? [];
    } catch (e) {
      logger.warn("docs pull requests not read", {
        projectId: project.id,
        error: errorMessage(e),
      });
    }
    const drift = reviews.reviews
      .flatMap((r) => r.findings)
      .filter((f) => f.status === "open" && /^doc drift/i.test(f.description));
    const out: DocView[] = STANDARD_DOCS.map((doc) => {
      const rel = docFile(doc);
      const found = locate(roots, rel);
      const finding = drift.find((f) => f.description.includes(doc) || f.description.includes(rel));
      const pr = found
        ? undefined
        : waiting.find((w) => w.path === rel || (rel.endsWith("/") && w.path.startsWith(rel)));
      if (pr && !finding)
        return {
          path: rel,
          title: TITLES[doc],
          exists: false,
          sizeBytes: 0,
          updatedAt: null,
          drift: false,
          note: `waiting in pull request #${pr.number}: merge it to add it`,
          pullRequest: { number: pr.number, url: pr.url },
        };
      return {
        path: rel,
        title: TITLES[doc],
        exists: found !== null,
        sizeBytes: found?.sizeBytes ?? 0,
        updatedAt: found?.updatedAt ?? null,
        drift: found !== null && finding !== undefined,
        note: finding
          ? finding.description
          : found
            ? rootLabel(project, found.root)
            : "not written yet",
      };
    });
    return c.json(out);
  });

  app.get("/projects/:id/docs/:path", async (c) => {
    const project = await owned(c.req.param("id"));
    if (!project) return c.json({ code: "forbidden", message: "not your project" }, 403);
    const rel = c.req.param("path");
    // Only the set's own files and the decision records in docs/decisions (design §3.4:
    // "all" links to the record): the path is never joined onto a root unchecked.
    if (!STANDARD_DOCS.some((doc) => docFile(doc) === rel) && !DECISION_RECORD.test(rel)) {
      throw new ForerunnerError("not_found", `${rel} is not one of the project's standard docs`);
    }
    const roots = deps.docsDirsFor(project);
    const found = locate(roots, rel);
    if (!found) throw new ForerunnerError("not_found", `${rel} is not written yet`);
    const bytes = readFileSync(found.file);
    let content = bytes.subarray(0, DOC_CONTENT_MAX_BYTES).toString("utf8");
    if (bytes.length > DOC_CONTENT_MAX_BYTES) content += "\n\n[cut at 512 KiB]";
    if (rel === docFile("docs/decisions/")) {
      const dir = join(found.root, fromPosix("docs/decisions"));
      const adrs = readdirSync(dir)
        .filter((n) => n.endsWith(".md") && n !== "README.md")
        .sort();
      if (adrs.length)
        content += `\n\nDecisions in this folder:\n${adrs.map((n) => `- ${n}`).join("\n")}\n`;
    }
    const view: DocContentView = { path: rel, content, updatedAt: found.updatedAt };
    return c.json(view);
  });

  // A repository project's pull requests that wait for the person (design §3.4 "Your files",
  // ADR 0106): each done task's and Forerunner's docs PRs, read from the host when asked.
  app.get("/projects/:id/pull-requests", async (c) => {
    const project = await owned(c.req.param("id"));
    if (!project) return c.json({ code: "forbidden", message: "not your project" }, 403);
    const view: ProjectPullRequestsView = deps.pullRequests
      ? await deps.pullRequests(project)
      : { repository: null, waiting: [], error: null };
    return c.json(view);
  });

  // The project's files (design §3.10): the folder its work is in, listed read-only, and one
  // file's text. The folder is the first of `docsDirsFor` (the linked folder, this install's
  // checkout of the repository, the workspace); a path never leaves it.
  app.get("/projects/:id/files", async (c) => {
    const project = await owned(c.req.param("id"));
    if (!project) return c.json({ code: "forbidden", message: "not your project" }, 403);
    const root = deps.docsDirsFor(project)[0] ?? null;
    if (!root) {
      const view: ProjectFilesView = { folder: null, entries: [], truncated: false };
      return c.json(view);
    }
    const view: ProjectFilesView = { folder: root, ...listProjectFiles(root) };
    return c.json(view);
  });

  app.get("/projects/:id/files/:path", async (c) => {
    const project = await owned(c.req.param("id"));
    if (!project) return c.json({ code: "forbidden", message: "not your project" }, 403);
    const rel = c.req.param("path");
    const root = deps.docsDirsFor(project)[0] ?? null;
    const file = root ? fileUnder(root, rel) : null;
    if (!file) throw new ForerunnerError("not_found", `${rel} is not a file of this project`);
    const st = statSync(file);
    if (!st.isFile()) throw new ForerunnerError("not_found", `${rel} is a folder`);
    const bytes = readFileSync(file);
    const head = bytes.subarray(0, FILE_CONTENT_MAX_BYTES);
    // Text is shown inline; a file with a NUL byte in its first 8 KiB is not text.
    const binary = head.subarray(0, 8192).includes(0);
    const view: ProjectFileContentView = {
      path: rel,
      content: binary ? null : head.toString("utf8"),
      sizeBytes: st.size,
      updatedAt: st.mtime.toISOString(),
      binary,
      truncated: !binary && bytes.length > FILE_CONTENT_MAX_BYTES,
    };
    return c.json(view);
  });

  return app;
}
