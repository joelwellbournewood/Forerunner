import { existsSync, readdirSync, rmSync } from "node:fs";
import type { TriedEvidence } from "@forerunner/critic";
import { type AppDirs, isInside, join, normalize, safeSegment } from "@forerunner/platform";

/**
 * "Try it" (ADR 0104, the owner's decision of 2026-11-01): work a person will use is also
 * started in its own environment and used as a person would, and what happened is evidence the
 * critic judges. For a page that is a headless browser on the task's folder: the page opened at
 * a desktop and a phone width with the network off, what did not load, the errors on the page,
 * the text a person sees and a screenshot of each width, stored for the person.
 *
 * The runtime owns the port; the browser lives in `@forerunner/capabilities`
 * (`browser/try-page.ts`), wired by the daemon. Without it (a test world, an install where no
 * Chromium, Edge or Chrome is found) the review says the work was not tried and why, and the
 * person sees "Reviewed", never "Reviewed and tried".
 */
export interface TryItPort {
  tryPages(req: TryPagesRequest): Promise<TryPagesResult>;
}

export interface TryPagesRequest {
  taskId: string;
  /** Unique per review (the run that produced the work): screenshots go under this folder. */
  reviewKey: string;
  /** The task's folder: pages are opened from it, and nothing outside it loads. */
  root: string;
  /** Pages to open, relative to `root`. */
  pages: string[];
  /**
   * The task gets a full review (ADR 0101, ADR 0110): its pages are opened only in a browser
   * whose own sandbox runs, never without it.
   */
  fullReview?: boolean;
  signal?: AbortSignal;
}

export type TryPagesResult =
  | { tried: TriedEvidence[] }
  /** No browser could be started: the reason in words ("no Chromium, Edge or Chrome found"). */
  | { unavailable: string };

/** At most this many pages are opened per review. */
export const MAX_PAGES_TRIED = 3;

/**
 * The pages a change asks to be tried: the HTML pages it changed (at most `MAX_PAGES_TRIED`),
 * else, when it changed a stylesheet or a script of a folder that has an `index.html`, that page.
 * None for a change without a page (a library, notes, data).
 */
export function pagesToTry(changedFiles: readonly string[], root: string | undefined): string[] {
  if (!root) return [];
  const files = changedFiles.map((f) => f.replace(/\\/g, "/"));
  const pages = files.filter(
    (f) => /\.html?$/i.test(f) && !f.split("/").some((s) => s === "node_modules" || s === ".git"),
  );
  const present = pages.filter((p) => existsSync(join(root, p)));
  if (present.length) return present.slice(0, MAX_PAGES_TRIED);
  const touchesPage = files.some((f) => /\.(css|m?js)$/i.test(f) && !f.includes("node_modules/"));
  if (touchesPage && existsSync(join(root, "index.html"))) return ["index.html"];
  return [];
}

/**
 * Where the screenshots of a try are kept: `<data>/evidence/<task id>/<review key>/`. The
 * daemon reads them back for the task drawer (`GET /tasks/:id/evidence?file=`).
 */
export function evidenceRootOf(dirs: Pick<AppDirs, "data">): string {
  return join(dirs.data, "evidence");
}

/**
 * The stored evidence file of a task named by `file` (`<review key>/<name>.png`, as the review
 * lists it), or null when the name leaves the task's evidence folder or is not a screenshot.
 */
export function evidenceFileOf(
  dirs: Pick<AppDirs, "data">,
  taskId: string,
  file: string,
): string | null {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.png$/.test(file)) return null;
  const base = join(evidenceRootOf(dirs), safeSegment(taskId));
  const abs = normalize(join(base, ...file.split("/")));
  return isInside(base, abs) ? abs : null;
}

/**
 * Before a task's page is tried again, the screenshots of its earlier reviews go (phase E,
 * C-20): a task keeps only its latest review's, which the drawer shows (`GET /tasks/:id/evidence`
 * serves them); a retry, Try again and Redo replace them instead of adding a folder each time.
 * Only folders under the task's own evidence folder are removed; a failure to remove one is
 * left for the next try and never stops this one.
 */
export function keepOnlyThisTry(
  dirs: Pick<AppDirs, "data">,
  taskId: string,
  reviewKey: string,
): void {
  const base = join(evidenceRootOf(dirs), safeSegment(taskId));
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === reviewKey) continue;
    const dir = normalize(join(base, name));
    if (!isInside(base, dir) || dir === normalize(base)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // held open (Windows) or already gone: the next try removes it
    }
  }
}
