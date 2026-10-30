import { readdirSync, readFileSync, statSync } from "node:fs";
import { docFile, STANDARD_DOCS } from "@forerunner/memory";
import { basename, ForerunnerError, fromPosix, join } from "@forerunner/platform";
import type { ProjectRow, StateStore } from "@forerunner/state";
import { Hono } from "hono";
import { WORKSPACE_DIR } from "../loop/docs.ts";
import type { DocContentView, DocView } from "./api-types.ts";
import { ownsProject, type Who } from "./ownership.ts";
import { reviewsView } from "./views.ts";

/**
 * The Docs tab (spec G.5, K.2; U-005 in docs/status/UPDATE-LOG.md): the standard doc set of a
 * project as this install has it, and one doc's text. The roots are `ProjectDocs.docsDirsFor`
 * in its order (a linked local folder, this install's docs clone of the repository, the
 * project's workspace), the same the chat's docs search reads; nothing is cloned or fetched, so
 * a repository's docs show as this install last wrote or pulled them. A doc's drift is an open
 * critic finding that names it.
 */
export interface DocsRoutesDeps {
  store: StateStore;
  /** The roots a project's docs are read from (`ProjectDocs.docsDirsFor`). */
  docsDirsFor: (project: ProjectRow) => string[];
  who: () => Who;
}

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
    const drift = reviews.reviews
      .flatMap((r) => r.findings)
      .filter((f) => f.status === "open" && /^doc drift/i.test(f.description));
    const out: DocView[] = STANDARD_DOCS.map((doc) => {
      const rel = docFile(doc);
      const found = locate(roots, rel);
      const finding = drift.find((f) => f.description.includes(doc) || f.description.includes(rel));
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
    // Only the set's own files: the path is never joined onto a root unchecked.
    if (!STANDARD_DOCS.some((doc) => docFile(doc) === rel)) {
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

  return app;
}
