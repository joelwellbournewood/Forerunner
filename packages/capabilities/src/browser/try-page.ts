import { createReadStream, mkdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  errorMessage,
  isInside,
  join,
  type Logger,
  log,
  normalize,
  safeSegment,
} from "@forerunner/platform";
import { type Browser, chromium } from "playwright";
import { resolveChromiumExecutable } from "./profile.ts";

/**
 * "Try it" for a page (ADR 0104, the owner's decision of 2026-11-01: work a person will use is
 * started in its own environment and used as a person would, with screenshots and outputs as
 * evidence the critic judges). A fresh headless Chromium, never an agent's profile, opens each
 * page from a loopback server that serves the task's folder and nothing else; every other
 * request is blocked (the network is off), so a page cannot reach anything outside its folder.
 * At each width it records what a person would meet: whether the page opened, its title, the
 * text on it, the files it links that did not load, the errors it threw, and a screenshot.
 *
 * The result is the critic's `TriedEvidence` (structurally; this package does not depend on the
 * critic): `ok` when nothing went wrong, `blocking` when a person would be stopped at once (the
 * page did not open, or it threw an error that no blocked request explains).
 */
export interface PageTry {
  what: string;
  target: string;
  ok: boolean;
  blocking: boolean;
  output: string;
  screenshots: { label: string; file: string }[];
  /**
   * The files of the folder the page asked for, found or not (relative paths, the page first):
   * what runs on it, so the review can tell whose change an error on the page belongs to.
   */
  pageFiles: string[];
}

export interface TryPagesOptions {
  /** The task's folder: pages are served from it, and nothing outside it is. */
  root: string;
  /** Pages to open, relative to `root` (forward slashes). */
  pages: readonly string[];
  /** Where the screenshots go (created). */
  outDir: string;
  /** How a screenshot's `file` is named in the result: `<prefix><name>.png`. Default "". */
  filePrefix?: string;
  /** Viewport widths, a desktop and a phone by default. */
  widths?: readonly number[];
  /** Per page and width. Default 20 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Tests hand in a launched browser; it is not closed. */
  browser?: Browser;
}

export type TryPagesOutcome = { tried: PageTry[] } | { unavailable: string };

export const TRY_WIDTHS: readonly number[] = [1280, 390];
const DEFAULT_TIMEOUT_MS = 20_000;
/** The page's visible text, evaluated in the page (a string: this package has no DOM types). */
const BODY_TEXT_SCRIPT = "document.body ? document.body.innerText : ''";
/** Text a person sees, as evidence: at most this many characters. */
const TEXT_SEEN_CHARS = 500;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Serves `root` read-only on 127.0.0.1 (a random port); dot files and folders are never served. */
async function serveFolder(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
      const abs = normalize(join(root, ...rel.split("/")));
      const hidden = rel.split("/").some((s) => s.startsWith("."));
      if (req.method !== "GET" || hidden || !isInside(root, abs) || !statSync(abs).isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      const ext = /\.[^./]+$/.exec(abs)?.[0]?.toLowerCase() ?? "";
      res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
      createReadStream(abs).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

/**
 * Opens each page at each width and says what a person would meet. Never throws for a page
 * that does not work (that is the evidence); `unavailable` when no browser can be started.
 */
export async function tryPages(opts: TryPagesOptions): Promise<TryPagesOutcome> {
  const logger = opts.logger ?? log("try-page");
  const widths = opts.widths?.length ? opts.widths : TRY_WIDTHS;
  let browser = opts.browser;
  const owned = !browser;
  if (!browser) {
    const probe = resolveChromiumExecutable(opts.env ?? process.env);
    if (!probe.ok) return { unavailable: "no Chromium, Edge or Chrome was found on this computer" };
    try {
      browser = await chromium.launch({
        headless: true,
        timeout: 60_000,
        ...(probe.executablePath ? { executablePath: probe.executablePath } : {}),
      });
    } catch (e) {
      return { unavailable: `the browser did not start (${errorMessage(e).split("\n")[0]})` };
    }
  }
  const { server, origin } = await serveFolder(opts.root);
  mkdirSync(opts.outDir, { recursive: true });
  const tried: PageTry[] = [];
  try {
    for (const target of opts.pages) {
      if (opts.signal?.aborted) break;
      tried.push(await tryOne(browser, origin, target, widths, opts, logger));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (owned) await browser.close().catch(() => {});
  }
  return { tried };
}

async function tryOne(
  browser: Browser,
  origin: string,
  target: string,
  widths: readonly number[],
  opts: TryPagesOptions,
  logger: Logger,
): Promise<PageTry> {
  const missing = new Set<string>();
  const asked = new Set<string>([target]);
  const blocked = new Set<string>();
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  let title = "";
  let seen = "";
  let opened = true;
  let openProblem = "";
  const screenshots: PageTry["screenshots"] = [];
  const name = safeSegment(target.replace(/\.[^./]+$/, "").replace(/[\\/]/g, "-"), "page");
  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: width >= 800 ? 800 : 844 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    try {
      // The network is off: the folder's own server, and data/blob URLs, nothing else.
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(`${origin}/`)) {
          const rel = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
          asked.add(rel === "" || rel.endsWith("/") ? `${rel}index.html` : rel);
          return route.continue();
        }
        if (url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
        blocked.add(hostOf(url));
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.on("response", (r) => {
        if (r.url().startsWith(`${origin}/`) && r.status() >= 400)
          missing.add(decodeURIComponent(new URL(r.url()).pathname.replace(/^\/+/, "")));
      });
      page.on("pageerror", (e) => {
        const line = (e.message || String(e)).split("\n")[0] ?? "";
        if (!errors.includes(line)) errors.push(line);
      });
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = m.text();
        // Load failures are reported once, as missing or blocked files.
        if (/Failed to load resource|ERR_BLOCKED_BY_CLIENT/i.test(text)) return;
        if (!consoleErrors.includes(text)) consoleErrors.push(text.slice(0, 300));
      });
      const url = `${origin}/${target.split("/").map(encodeURIComponent).join("/")}`;
      try {
        const res = await page.goto(url, {
          waitUntil: "load",
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        if (!res || res.status() >= 400) {
          opened = false;
          openProblem = `${target} did not open (${res ? `status ${res.status()}` : "no answer"})`;
        }
      } catch (e) {
        opened = false;
        openProblem = `${target} did not open (${errorMessage(e).split("\n")[0]})`;
      }
      if (opened) {
        await page.waitForTimeout(300);
        if (!title) title = (await page.title().catch(() => "")).trim();
        if (!seen)
          seen = ((await page.evaluate(BODY_TEXT_SCRIPT).catch(() => "")) as string)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, TEXT_SEEN_CHARS);
        const file = `${name}-${width}.png`;
        try {
          await page.screenshot({
            path: join(opts.outDir, file),
            fullPage: false,
            timeout: 15_000,
          });
          screenshots.push({
            label:
              width >= 800 ? `${width} pixels wide (a computer)` : `${width} pixels wide (a phone)`,
            file: `${opts.filePrefix ?? ""}${file}`,
          });
        } catch (e) {
          logger.warn("try screenshot failed", { target, width, error: errorMessage(e) });
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
    if (!opened) break;
  }
  const problems: string[] = [];
  if (!opened) problems.push(openProblem);
  for (const m of missing) if (m !== target) problems.push(`${m} did not load (not found)`);
  for (const e of errors) problems.push(`error on the page: ${e}`);
  for (const c of consoleErrors) problems.push(`console error: ${c}`);
  const lines = [
    `${opened ? "opened" : "tried to open"} ${target} at ${widths.join(" and ")} pixels wide, the network off`,
    ...(title ? [`title: ${title}`] : opened ? ["title: (none)"] : []),
    ...(opened ? [`text seen: ${seen || "(no text)"}`] : []),
    ...problems.map((p) => `problem: ${p}`),
    ...(blocked.size
      ? [
          `blocked (the network is off during the try): ${[...blocked].slice(0, 5).join(", ")}${
            errors.length ? "; the errors above may come from that" : ""
          }`,
        ]
      : []),
  ];
  return {
    what: `opened ${target} in a browser, ${widths.join(" and ")} pixels wide`,
    target,
    ok: problems.length === 0,
    blocking: !opened || (errors.length > 0 && blocked.size === 0),
    output: lines.join("\n"),
    screenshots,
    pageFiles: [...asked],
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}
