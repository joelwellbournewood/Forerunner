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
import { type Browser, chromium, type LaunchOptions } from "playwright";
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
  /** ADR 0110: a page (a command and a server are tried by the runtime in the task's sandbox). */
  kind: "page";
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
  /**
   * The page of a full-review task (ADR 0101, ADR 0110): opened only in a browser whose own
   * sandbox runs. Where Chromium's sandbox cannot start, such a page is not tried (and the
   * review says why) instead of being opened without it.
   */
  requireBrowserSandbox?: boolean;
  /** How the browser is started; default Playwright's `chromium.launch`. Tests hand in one. */
  launch?: (opts: LaunchOptions) => Promise<Browser>;
  /** How the folder is served; default a loopback server on a random port. Tests hand in one. */
  serve?: (root: string) => Promise<{ server: ServedFolder; origin: string }>;
}

export type TryPagesOutcome = { tried: PageTry[] } | { unavailable: string };

/** The served folder as the try needs it: something it can close. */
export interface ServedFolder {
  close(done: () => void): unknown;
}

/**
 * What the evidence says when the browser ran without its own sandbox (C-17): Chromium could not
 * start with it here (Linux as root, no user namespaces), and the page was of a light review.
 */
export const NO_BROWSER_SANDBOX = "the browser ran without its own sandbox";

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
  let unsandboxed: string | null = null;
  if (!browser) {
    const probe = resolveChromiumExecutable(opts.env ?? process.env);
    if (!probe.ok) return { unavailable: "no Chromium, Edge or Chrome was found on this computer" };
    const started = await launchBrowser(opts, probe.executablePath);
    if ("unavailable" in started) return started;
    browser = started.browser;
    unsandboxed = started.unsandboxed;
    if (unsandboxed) logger.warn("page try without the browser's sandbox", { why: unsandboxed });
  }
  // R-1: everything after the launch is inside the try whose finally closes the browser, so a
  // folder that cannot be served (or screenshots that cannot be stored) leaves nothing running.
  let server: ServedFolder | null = null;
  const tried: PageTry[] = [];
  try {
    let origin: string;
    try {
      ({ server, origin } = await (opts.serve ?? serveFolder)(opts.root));
    } catch (e) {
      return {
        unavailable: `the task's folder could not be served to the browser (${firstLine(e)})`,
      };
    }
    try {
      mkdirSync(opts.outDir, { recursive: true });
    } catch (e) {
      return { unavailable: `the screenshots could not be stored (${firstLine(e)})` };
    }
    for (const target of opts.pages) {
      if (opts.signal?.aborted) break;
      const t = await tryOne(browser, origin, target, widths, opts, logger);
      tried.push(
        unsandboxed
          ? {
              ...t,
              output: `${t.output}\n${NO_BROWSER_SANDBOX}: it could not start with it on this computer (${unsandboxed})`,
            }
          : t,
      );
    }
  } finally {
    const open = server;
    if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
    if (owned) await browser.close().catch(() => {});
  }
  return { tried };
}

/**
 * Starts Chromium with its own sandbox on (C-17: Playwright's default turns it off). Where it
 * cannot start with it (Linux as root, a kernel without user namespaces), a light review's page
 * is opened without it and the evidence says so; a full review's page is not opened at all
 * (`requireBrowserSandbox`, ADR 0110).
 */
async function launchBrowser(
  opts: TryPagesOptions,
  executablePath: string | undefined,
): Promise<{ browser: Browser; unsandboxed: string | null } | { unavailable: string }> {
  const launch = opts.launch ?? ((o: LaunchOptions) => chromium.launch(o));
  const base: LaunchOptions = {
    headless: true,
    timeout: 60_000,
    ...(executablePath ? { executablePath } : {}),
  };
  try {
    return { browser: await launch({ ...base, chromiumSandbox: true }), unsandboxed: null };
  } catch (e) {
    const why = sandboxRefusal(e);
    if (opts.requireBrowserSandbox)
      return {
        unavailable: `the browser could not start with its own sandbox on this computer (${why}), and a page of a full-review task is only opened with it`,
      };
    try {
      return { browser: await launch({ ...base, chromiumSandbox: false }), unsandboxed: why };
    } catch (e2) {
      return { unavailable: `the browser did not start (${firstLine(e2)})` };
    }
  }
}

/** The line of a failed launch that says why (Playwright puts the browser's own words last). */
function sandboxRefusal(e: unknown): string {
  const lines = errorMessage(e)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const said = lines.find((l) => /sandbox/i.test(l) && !/^browserType\./.test(l));
  return (said ?? lines[0] ?? "it did not start").slice(0, 200);
}

function firstLine(e: unknown): string {
  return (errorMessage(e).split("\n")[0] ?? "").slice(0, 200);
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
    kind: "page",
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
