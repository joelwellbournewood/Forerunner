#!/usr/bin/env node
// The desktop window check (phase F2; docs/maintainers/testing.md, "The desktop window check").
// Every walk before it drove the UI in Chromium, but the desktop shell opens links, files and
// windows its own way: the owner's "Clicking PR does nothing" was a shell-only bug
// (apps/desktop/src-tauri/src/windows.rs, on_navigation / on_new_window). This drives the
// INSTALLED app's own window, as a person uses it, and asserts what the SHELL did.
//
// What it does (`--exe`, Windows CI after the MSI is installed):
//   1. copies the stand-in model (testenv/src/bench and testenv/src/provider) into the installed
//      runtime: `fr daemon --provider bench` loads it from <runtime>/testenv and refuses to start
//      without it, so an install never runs the stand-in unless a test put it there;
//   2. starts the installed exe the way a person does (no arguments) on a fresh data folder, with
//      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port> (the window's DevTools;
//      also wry's disabled features and occlusion tracking off, `WEBVIEW2_DISABLED_FEATURES`)
//      and FORERUNNER_DAEMON_PROVIDER=bench (the shell starts its daemon on the stand-in model,
//      apps/desktop/src-tauri/src/supervisor.rs `daemon_flags`);
//   3. waits for the daemon (daemon.json, /health) and for the window's page on the DevTools
//      endpoint, and drives that page over raw CDP (apps/mobile/e2e/cdp.mjs, the Android
//      emulator job's driver): Set up later, New project with a one-line brief, the plan card in
//      the Inbox, Approve and start, the session to its end, the Tasks tab;
//   4. then the shell's hand-offs, each read back from the shell's own log
//      (<home>/logs/desktop-shell.log: "handed to the system browser (link|new window): <url>",
//      "handed to the file manager: <folder>"): the PR link on the Tasks tab (the task's pr_url is
//      written into the store first, pointing at a page this script serves, so it can also see
//      the browser fetch it), Settings → Sandbox's "Get Docker Desktop" link, a target="_blank"
//      link (the new-window path), a file: link (must open nothing) and Open folder on the
//      Overview. After each, the window must still show the app on the same page;
//   5. saves a screenshot (Page.captureScreenshot) and the visible text of every step, and of
//      the page where the journey stopped (with `--exe`, the whole screen there too:
//      `desktopScreenshot`), the shell's and the daemon's logs and result.json under --out;
//      ends the app (POST /shutdown, then the shell's process tree).
// Exit 1 when a required check failed. The step summary on GitHub lists every check.
//
// `--attach <DevTools URL>` drives a page that is already open instead (a dry run of the journey
// against a bench in Chromium, `--home` the bench's home): no shell, so the hand-off checks are
// reported as skipped. Usage:
//   node scripts/desktop-window-check.mjs --exe <installed .exe> --home <new data folder> --out <dir>
//        [--cdp-port 9333] [--runtime-dir <install>/runtime] [--timeout-min 20]
//   node scripts/desktop-window-check.mjs --attach http://127.0.0.1:9333 --app-origin <ui url>
//        --home <bench home> --out <dir>
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, describePage, listTargets } from "../apps/mobile/e2e/cdp.mjs";
import { forwardPageConsole } from "../apps/mobile/e2e/webview-console.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the shell's own pages live (apps/desktop/src-tauri/src/inject.rs `app_origins`). */
export const APP_ORIGINS = Object.freeze([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

/** What the stand-in model needs from testenv/, copied into <runtime>/testenv/. */
export const STAND_IN_PARTS = Object.freeze(["package.json", "src/bench", "src/provider"]);

/** The Settings card's link while Docker is not installed (sandbox/readiness-types.ts). */
export const DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/";

/** Variables never passed to the app: model credentials and this machine's tokens. */
export const NEVER_PASSED = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

/**
 * The options; unknown arguments are refused. `--exe` and `--attach` exclude each other and one
 * of them is required; `--home` and `--out` are required.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = {
    exe: null,
    attach: null,
    appOrigin: null,
    home: null,
    out: null,
    runtimeDir: null,
    cdpPort: 9333,
    timeoutMin: 20,
    brief: "A page that shows a random quote",
    project: "Window check",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--exe") out.exe = value();
    else if (a === "--attach") out.attach = value();
    else if (a === "--app-origin") out.appOrigin = value();
    else if (a === "--home") out.home = value();
    else if (a === "--out") out.out = value();
    else if (a === "--runtime-dir") out.runtimeDir = value();
    else if (a === "--brief") out.brief = value();
    else if (a === "--project") out.project = value();
    else if (a === "--cdp-port" || a === "--timeout-min") {
      const n = Number(value());
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${a} needs a positive whole number`);
      if (a === "--cdp-port") out.cdpPort = n;
      else out.timeoutMin = n;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.exe === !out.attach)
    throw new Error("give either --exe <installed app> or --attach <DevTools URL>");
  if (!out.home) throw new Error("--home <data folder> is required");
  if (!out.out) throw new Error("--out <folder for screenshots and logs> is required");
  return out;
}

/**
 * The features wry turns off in WebView2 when the app names no browser arguments
 * (wry's webview2/mod.rs), plus `CalculateNativeWinOcclusion`: once the system browser opens
 * over the window (the PR link), Chromium's occlusion tracking may stop painting the covered
 * page, and the driver's clicks wait for animation frames. WebView2 may use the variable in
 * place of the app's own arguments, so wry's list is repeated here.
 */
export const WEBVIEW2_DISABLED_FEATURES = Object.freeze([
  "msWebOOUI",
  "msPdfOOUI",
  "msSmartScreenProtection",
  "CalculateNativeWinOcclusion",
]);

/**
 * The installed app's environment: a fresh data folder, the stand-in model, the window's
 * DevTools on `cdpPort`, the vault a file in that folder (never this machine's keyring), and
 * no model credential, token or other FORERUNNER_* setting of this machine.
 * `FORERUNNER_SANDBOX_ENGINE=podman` makes the sandbox "not installed" whatever Docker the
 * runner has, so Settings shows the "Get Docker Desktop" link this check clicks.
 * @param {Record<string, string | undefined>} base
 * @param {{ home: string, cdpPort: number }} opts
 */
export function windowEnv(base, { home, cdpPort }) {
  const env = { ...base };
  for (const k of NEVER_PASSED) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith("FORERUNNER_")) delete env[k];
  env.FORERUNNER_HOME = home;
  env.FORERUNNER_DAEMON_PROVIDER = "bench";
  env.FORERUNNER_VAULT_BACKEND = "file";
  env.FORERUNNER_SANDBOX_ENGINE = "podman";
  env.FORERUNNER_BENCH_DELAY_MS = "100";
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${cdpPort} --disable-features=${WEBVIEW2_DISABLED_FEATURES.join(",")}`;
  return env;
}

/** Windows PowerShell: the whole desktop into the PNG named by `FR_SHOT` (.NET's screen copy). */
const DESKTOP_SHOT_PS = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
  "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
  "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
  "$g = [System.Drawing.Graphics]::FromImage($bmp)",
  "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)",
  "$bmp.Save($env:FR_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)",
  "$g.Dispose()",
  "$bmp.Dispose()",
].join("; ");

/**
 * A screenshot of the whole screen where the journey stopped: a stop before the window's page
 * could be driven (no daemon, no DevTools page) has no page to capture, and a dialog of the
 * shell's is outside the page. Windows only; the file's path goes in an environment variable,
 * never into the script text. Returns what happened, in words.
 * @param {string} file
 * @param {{ platform?: string, run?: typeof spawnSync }} [deps]
 */
export function desktopScreenshot(file, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== "win32") return "no desktop screenshot (not Windows)";
  const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DESKTOP_SHOT_PS], {
    env: { ...process.env, FR_SHOT: file },
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  if (r.status === 0 && existsSync(file)) return `desktop screenshot: ${file}`;
  const why = String(r.error?.message ?? r.stderr ?? "").trim();
  return `desktop screenshot failed: ${why ? oneLine(why) : `exit ${r.status}`}`;
}

/**
 * Copies the stand-in model into an installed runtime (`<runtime>/testenv/...`, where
 * `fr daemon --provider bench` looks). Refuses a folder that is no runtime. Returns what it
 * copied, relative to the runtime.
 * @param {string} repoRoot
 * @param {string} runtimeDir
 */
export function installStandIn(repoRoot, runtimeDir) {
  const cli = path.join(runtimeDir, "packages", "runtime", "src", "cli", "main.ts");
  if (!existsSync(cli)) throw new Error(`${runtimeDir} is not an installed runtime (no ${cli})`);
  const copied = [];
  for (const part of STAND_IN_PARTS) {
    const segments = part.split("/");
    cpSync(
      path.join(repoRoot, "testenv", ...segments),
      path.join(runtimeDir, "testenv", ...segments),
      {
        recursive: true,
      },
    );
    copied.push(path.join("testenv", ...segments));
  }
  return copied;
}

/**
 * Whether `url` is one of the app's own pages.
 * @param {string} url
 * @param {readonly string[]} [origins]
 */
export function isAppUrl(url, origins = APP_ORIGINS) {
  const s = String(url ?? "");
  return origins.some((o) => s === o || s.startsWith(`${o}/`));
}

/**
 * The shell's hand-offs in its log (apps/desktop/src-tauri/src/windows.rs `handed_to_browser_line`
 * and the refusal, folder.rs `handed_to_file_manager_line`), in order. tauri-plugin-log writes
 * `[date][time][module][LEVEL] message`; the message ends the line.
 * @param {string} text
 * @returns {Array<{ kind: "browser", via: string, target: string } | { kind: "folder", target: string } | { kind: "refused", scheme: string, via: string | null }>}
 */
export function parseHandoffs(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m =
      /handed to the system browser \((link|new window)\): (\S+)(?: \(query not logged\))?$/.exec(
        line,
      );
    if (m) {
      out.push({ kind: "browser", via: m[1], target: m[2] });
      continue;
    }
    m = /handed to the file manager: (.+)$/.exec(line);
    if (m) {
      out.push({ kind: "folder", target: m[1].trim() });
      continue;
    }
    m = /opening (\S+) from the window refused(?: \((link|new window)\))?/.exec(line);
    if (m) out.push({ kind: "refused", scheme: m[1], via: m[2] ?? null });
  }
  return out;
}

/**
 * Two spellings of one folder: on Windows case and `/` versus `\` do not matter; a trailing
 * separator never does.
 * @param {string} a
 * @param {string} b
 * @param {boolean} [windows]
 */
export function sameFolder(a, b, windows = process.platform === "win32") {
  const norm = (p) => {
    let s = String(p ?? "").trim();
    if (windows) s = s.replace(/\//g, "\\").toLowerCase();
    return s.replace(/[\\/]+$/, "");
  };
  return norm(a) !== "" && norm(a) === norm(b);
}

/**
 * Writes the PR link onto a task in the daemon's store (`<home>/data/state.sqlite`, table
 * `task`), the column the Tasks tab's PR link reads. The daemon has no route for it (the PR
 * executor sets it); the window check needs a task with a PR, not a pull request.
 * @param {string} dbFile
 * @param {string} taskId
 * @param {string} prUrl
 * @param {string} nowIso
 */
export async function seedPrUrl(dbFile, taskId, prUrl, nowIso) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const r = db
      .prepare(
        'UPDATE "task" SET "pr_url" = ?, "updated_at" = ?, "version" = "version" + 1 WHERE "id" = ?',
      )
      .run(prUrl, nowIso, taskId);
    if (Number(r.changes) !== 1) throw new Error(`no task ${taskId} in ${dbFile}`);
  } finally {
    db.close();
  }
}

/**
 * A page on 127.0.0.1 for the links the window hands to the system browser: it records every
 * request, so the check can see whether the browser really opened the URL.
 * @returns {Promise<{ base: string, hits: Array<{ method: string, path: string, at: string }>, close: () => Promise<void> }>}
 */
export async function startLinkServer() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? "?", path: req.url ?? "/", at: new Date().toISOString() });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><meta charset=utf-8><title>Forerunner window check</title><p>The system browser opened this page.</p>",
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/**
 * The step summary: one line per check, a skipped check said as such.
 * @param {string} title
 * @param {Array<{ name: string, ok: boolean, skipped?: boolean, required?: boolean, detail?: string }>} checks
 */
export function summaryMarkdown(title, checks) {
  const failed = checks.filter((c) => !c.ok && !c.skipped && c.required !== false).length;
  return [
    `### ${title}`,
    "",
    failed ? `**${failed} required check(s) failed.**` : "Every required check passed.",
    "",
    ...checks.map((c) => {
      const state = c.skipped ? "skipped" : c.ok ? "ok" : c.required === false ? "note" : "FAILED";
      return `- ${state}: ${c.name}${c.detail ? ` (${oneLine(c.detail)})` : ""}`;
    }),
    "",
  ].join("\n");
}

function oneLine(s) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A step of the journey that cannot go on; the rest is reported as not reached. */
class Stop extends Error {}

async function until(what, ms, everyMs, fn) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (e instanceof Stop) throw e;
      last = e;
    }
    if (Date.now() >= end)
      throw new Error(
        `${what}: not within ${Math.round(ms / 1000)} s${last ? ` (${last.message})` : ""}`,
      );
    await sleep(everyMs);
  }
}

function readDaemonFile(home) {
  const file = path.join(home, "runtime", "daemon.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

async function healthy(daemon) {
  const res = await fetch(`${daemon.url}/health`, {
    headers: { authorization: `Bearer ${daemon.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  return res.ok;
}

function apiFor(daemon) {
  return async (method, route, body) => {
    const res = await fetch(`${daemon.url}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${daemon.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

/** The shell log's bytes from `offset` on (the file only grows during the check). */
function logSince(file, offset) {
  if (!file || !existsSync(file)) return "";
  return readFileSync(file).subarray(offset).toString("utf8");
}

/**
 * What the shell said about links and folders since `offset`: the lines a failed hand-off check
 * shows (a browser that would not open, a refusal).
 */
function shellSaid(file, offset) {
  const lines = logSince(file, offset)
    .split(/\r?\n/)
    .filter((l) => /browser|refused|folder|could not/i.test(l))
    .map((l) => l.replace(/^(\[[^\]]*\])+\s*/, ""));
  return lines.length ? `the shell said: ${lines.slice(-3).join(" | ")}` : `nothing in ${file}`;
}

function logSize(file) {
  return file && existsSync(file) ? statSync(file).size : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const out = path.resolve(opts.out);
  const home = path.resolve(opts.home);
  mkdirSync(out, { recursive: true });
  const shellMode = !!opts.exe;
  const origins = opts.appOrigin ? [opts.appOrigin.replace(/\/+$/, "")] : APP_ORIGINS;
  const deadline = Date.now() + opts.timeoutMin * 60_000;
  const left = (cap) => Math.max(5_000, Math.min(cap, deadline - Date.now()));
  const checks = [];
  const result = {
    mode: shellMode ? "installed app" : "attached page",
    home,
    checks,
    startedAt: new Date().toISOString(),
  };
  const check = (name, ok, detail = "", extra = {}) => {
    checks.push({ name, ok: !!ok, detail: String(detail ?? ""), ...extra });
    const state = extra.skipped ? "skip" : ok ? "ok  " : extra.required === false ? "note" : "FAIL";
    console.log(`${state} ${name}${detail ? `: ${oneLine(detail)}` : ""}`);
    return !!ok;
  };
  const must = (name, ok, detail = "") => {
    if (!check(name, ok, detail)) throw new Stop(name);
  };
  const skip = (name, why) => check(name, false, why, { skipped: true });
  const shellLog = path.join(home, "logs", "desktop-shell.log");
  const daemonLog = path.join(home, "logs", "daemon-shell.log");
  let app = null;
  let daemon = null;
  let link = null;
  let client = null;
  /** @type {((label: string) => Promise<string>) | null} set once the window's page is driven */
  let shot = null;
  const pageErrors = [];

  try {
    link = await startLinkServer();
    if (shellMode) {
      // 1-2. The stand-in model in the installed runtime, then the app as a person starts it.
      if (existsSync(path.join(home, "runtime", "daemon.json")))
        throw new Error(`${home} was used before: give a fresh data folder`);
      mkdirSync(home, { recursive: true });
      const runtimeDir = path.resolve(
        opts.runtimeDir ?? path.join(path.dirname(opts.exe), "runtime"),
      );
      result.standIn = installStandIn(REPO, runtimeDir);
      console.log(`stand-in model copied into ${runtimeDir}: ${result.standIn.join(", ")}`);
      app = spawn(opts.exe, [], {
        env: windowEnv(process.env, { home, cdpPort: opts.cdpPort }),
        stdio: "ignore",
        windowsHide: false,
      });
      result.appPid = app.pid;
      app.on("exit", (code) => console.log(`the app exited (code ${code})`));
    }

    // 3. The daemon and the window's page.
    daemon = await until("the daemon to answer /health", left(300_000), 1_000, async () => {
      if (app && app.exitCode !== null)
        throw new Stop(`the app exited with ${app.exitCode} before its daemon answered`);
      const d = readDaemonFile(home);
      return d && (await healthy(d)) ? d : null;
    }).catch((e) => e);
    if (daemon instanceof Error) {
      check("the app starts its daemon", false, daemon.message);
      throw new Stop("no daemon");
    }
    check("the app starts its daemon", true, daemon.url);
    const api = apiFor(daemon);
    if (shellMode) {
      const said = existsSync(daemonLog) ? readFileSync(daemonLog, "utf8") : "";
      check(
        "the shell started it on the stand-in model (FORERUNNER_DAEMON_PROVIDER)",
        said.includes('the daemon runs on the stand-in model "bench"'),
        said
          .split(/\r?\n/)
          .filter((l) => l.startsWith("[shell]"))
          .slice(-3)
          .join(" | "),
      );
    }
    const cdpBase = opts.attach ?? `http://127.0.0.1:${opts.cdpPort}`;
    const target = await until(
      "the window's page on the DevTools endpoint",
      left(180_000),
      1_000,
      async () => {
        const targets = await listTargets(cdpBase, { timeoutMs: 5_000 });
        return targets.find((t) => t.type === "page" && isAppUrl(t.url, origins)) ?? null;
      },
    ).catch((e) => e);
    must(
      "the window's page is reachable over DevTools",
      !(target instanceof Error),
      target instanceof Error ? target.message : String(target.url),
    );
    const connected = await connectPage(cdpBase, {
      prefer: (t) => t.id === target.id,
      timeoutMs: 30_000,
      waitForTargetMs: 10_000,
    });
    client = connected.client;
    const page = connected.page;
    client.onEvent(({ method, params }) => {
      if (method === "Runtime.exceptionThrown")
        pageErrors.push(
          String(
            params?.exceptionDetails?.exception?.description ??
              params?.exceptionDetails?.text ??
              "exception",
          ).split("\n")[0],
        );
    });
    await forwardPageConsole(client, { timeoutMs: 10_000 });
    await client.send("Page.bringToFront", {}).catch(() => undefined);

    let shotNo = 0;
    shot = async (label) => {
      shotNo += 1;
      const name = `${String(shotNo).padStart(2, "0")}-${slug(label)}`;
      try {
        await sleep(400);
        const r = await client.send(
          "Page.captureScreenshot",
          { format: "png" },
          { timeoutMs: 30_000 },
        );
        writeFileSync(path.join(out, `${name}.png`), Buffer.from(String(r.data), "base64"));
      } catch (e) {
        console.log(`screenshot ${name} failed: ${e.message}`);
      }
      const text = await describePage(page).catch((e) => `(page text unavailable: ${e.message})`);
      writeFileSync(path.join(out, `${name}.txt`), `${text}\n`);
      return text;
    };
    const bodyText = async () =>
      String(await page.evaluate("document.body ? document.body.innerText : ''"));
    const waitText = (what, re, ms) =>
      until(what, ms, 500, async () => (re.test(await bodyText()) ? true : null));

    // Setup: skipped the way a person in a hurry does.
    await waitText("the first screen", /\S/, 60_000);
    await shot("first screen");
    if (/Set up Forerunner/.test(await bodyText())) {
      await page.getByRole("button", { name: "Set up later", exact: true }).first().click();
      await sleep(1_000);
      check(
        "the setup assistant can be left for later",
        !/Set up Forerunner/.test(await bodyText()),
      );
    } else check("the setup assistant can be left for later", true, "not shown");
    await shot("home");

    // New project with a one-line brief.
    const projectName = `${opts.project} ${new Date().toISOString().slice(11, 19)}`;
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.locator('input[name="name"]').fill(projectName);
    await page.locator('textarea[name="brief"]').fill(opts.brief);
    await shot("new project dialog");
    await page.getByTestId("create-project").click();
    const projectId = await until("the project page", 30_000, 500, async () => {
      const m = /\/projects\/([^/?#]+)/.exec(await page.url());
      return m ? decodeURIComponent(m[1]) : null;
    }).catch(() => null);
    must("New project with a one-line brief opens the project", !!projectId, await page.url());
    result.projectId = projectId;
    await shot("project created");

    // The plan card.
    const intake = await until("the plan", left(300_000), 2_000, async () => {
      const s = await api("GET", `/projects/${encodeURIComponent(projectId)}/intake`);
      return s.state === "pending" || s.state === "failed" ? s : null;
    }).catch((e) => ({ state: "timeout", error: e.message }));
    must(
      "planning ends in a plan",
      intake.state === "pending",
      `${intake.state}${intake.error ? `: ${intake.error}` : ""}`,
    );
    await page.getByRole("link", { name: "Inbox" }).first().click();
    const card = page
      .getByTestId("request")
      .filter({ has: page.getByText(`Plan for "${projectName}"`) });
    await card.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const cards = await card.count();
    const tasksOnCard = cards === 1 ? await card.getByTestId("intake-task").count() : 0;
    await shot("inbox plan card");
    must(
      "the Inbox shows the plan card with its tasks",
      cards === 1 && tasksOnCard > 0,
      `${cards} card(s), ${tasksOnCard} task line(s)`,
    );

    // Approve and start: the session runs to its end.
    await card.getByRole("button", { name: "Approve and start", exact: true }).click();
    const approved = await waitText(
      "the approval's words",
      /Plan approved: \d+ tasks? written/,
      30_000,
    )
      .then(() => true)
      .catch(() => false);
    await shot("approved");
    check("Approve and start says the plan was written and work started", approved);
    const session = await until("the session Approve and start began", 60_000, 1_000, async () => {
      const list = await api("GET", `/sessions?projectId=${encodeURIComponent(projectId)}`);
      return (Array.isArray(list) ? list : []).find((s) => s.projectId === projectId) ?? null;
    }).catch(() => null);
    must("a session starts", !!session, session ? session.id : "none in 60 s");
    // Home, then the project's card, as a person goes back to it.
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    await page
      .getByTestId("project-card")
      .filter({ has: page.getByText(projectName, { exact: true }) })
      .getByTestId("open-project")
      .click();
    await shot("project while the session runs");
    const ended = await until("the session to end", left(900_000), 2_000, async () => {
      const s = await api("GET", `/sessions/${encodeURIComponent(session.id)}`);
      return ["completed", "stopped", "failed", "killed"].includes(s.status) ? s : null;
    }).catch((e) => ({ status: "timeout", summary: e.message }));
    check(
      "the session ends",
      ended.status === "completed",
      `${ended.status}: ${ended.summary ?? ""}`,
    );
    const tasks = await api("GET", `/projects/${encodeURIComponent(projectId)}/tasks`);
    const done = tasks.filter((t) => t.status === "done");
    check(
      "every planned task is done",
      tasks.length > 0 && done.length === tasks.length,
      tasks.map((t) => `${t.title}: ${t.status}`).join("; "),
    );
    await page.getByTestId("tab-summary").click();
    await sleep(1_500);
    await shot("overview after the session");
    await page.getByTestId("tab-tasks").click();
    await sleep(1_500);
    await shot("tasks tab");
    const tasksText = await bodyText();
    check(
      "the Tasks tab shows the finished tasks",
      done.length > 0 && done.every((t) => tasksText.includes(t.title)),
      `${done.length} done`,
    );

    // 4. The shell's hand-offs.
    const handoffSince = async (offset, pick, ms = 15_000) =>
      until(
        "the shell's hand-off line",
        ms,
        500,
        async () => parseHandoffs(logSince(shellLog, offset)).find(pick) ?? null,
      ).catch(() => null);
    // In a browser (--attach) a link opens a new tab, which puts this page in the background,
    // where it stops painting; the shell opens none.
    const backToPage = async () => {
      if (!shellMode) await client.send("Page.bringToFront", {}).catch(() => undefined);
    };
    const stays = async (before, label) => {
      await sleep(1_500);
      const after = await page.url();
      const ok = isAppUrl(after, origins) && after === before;
      check(
        `the window stays on the app's page after ${label}`,
        ok,
        ok ? after : `before ${before}, after ${after}`,
      );
    };

    // The PR link on the Tasks tab (the owner's complaint 1).
    const prTask = done[0] ?? tasks[0];
    const prUrl = `${link.base}/acme/window-check/pull/1`;
    await seedPrUrl(
      path.join(home, "data", "state.sqlite"),
      prTask.id,
      prUrl,
      new Date().toISOString(),
    );
    await page.getByTestId("tab-summary").click();
    await sleep(800);
    await page.getByTestId("tab-tasks").click();
    const prLink = page.getByTestId("pr-link");
    await prLink.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const prShown = (await prLink.count()) === 1;
    must("the Tasks tab shows the task's PR link", prShown, `${await prLink.count()} PR link(s)`);
    await shot("tasks tab with a PR");
    const beforePr = await page.url();
    let offset = logSize(shellLog);
    await prLink.click();
    await backToPage();
    if (shellMode) {
      const h = await handoffSince(offset, (x) => x.kind === "browser" && x.target === prUrl);
      check(
        "clicking PR hands the pull request to the system browser",
        !!h,
        h ? `${h.via}: ${h.target}` : shellSaid(shellLog, offset),
      );
      await stays(beforePr, "the PR click");
      const fetched = await until("the browser to fetch the PR page", 20_000, 500, async () =>
        link.hits.some((x) => x.path === "/acme/window-check/pull/1"),
      ).catch(() => false);
      check(
        "the system browser opened the PR page",
        fetched,
        fetched
          ? "the page was fetched"
          : "no request reached the page (a browser's first run may not load it)",
        { required: false },
      );
    } else skip("clicking PR hands the pull request to the system browser", "no shell (--attach)");
    await shot("after the PR click");

    // A link that asks for a new window (target="_blank", window.open): the new-window path.
    const newWindowUrl = `${link.base}/window-check/new-window`;
    await page.evaluate(injectLinkScript("fr-check-new-window", newWindowUrl, "_blank"));
    offset = logSize(shellLog);
    const beforeNew = await page.url();
    await page.getByTestId("fr-check-new-window").click();
    await backToPage();
    if (shellMode) {
      const h = await handoffSince(
        offset,
        (x) => x.kind === "browser" && x.target === newWindowUrl,
      );
      check(
        'a target="_blank" link goes to the system browser (new window)',
        !!h && h.via === "new window",
        h ? `${h.via}: ${h.target}` : shellSaid(shellLog, offset),
      );
      await stays(beforeNew, "a new-window link");
    } else
      skip('a target="_blank" link goes to the system browser (new window)', "no shell (--attach)");

    // A file: link opens nothing, in no program.
    await page.evaluate(injectLinkScript("fr-check-file", "file:///C:/Windows/win.ini", ""));
    offset = logSize(shellLog);
    const beforeFile = await page.url();
    await page.getByTestId("fr-check-file").click();
    await backToPage();
    await sleep(3_000);
    if (shellMode) {
      const seen = parseHandoffs(logSince(shellLog, offset));
      check(
        "a file: link is handed to no program",
        !seen.some((x) => x.kind !== "refused"),
        seen
          .map((x) => (x.kind === "refused" ? `refused ${x.scheme}` : `${x.kind}: ${x.target}`))
          .join("; ") ||
          "nothing handed off, and no refusal logged (the webview may stop a file: link before the shell sees it)",
      );
      await stays(beforeFile, "a file: link");
    } else skip("a file: link is handed to no program", "no shell (--attach)");
    await page.evaluate(
      "(() => { for (const id of ['fr-check-new-window', 'fr-check-file']) document.getElementById(id)?.remove(); return true; })()",
    );

    // Open folder on the Overview.
    await page.getByTestId("tab-summary").click();
    const folderPath = page.getByTestId("folder-path");
    await folderPath.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const shownFolder =
      (await folderPath.count()) === 1 ? (await folderPath.innerText()).trim() : "";
    check(
      "the Overview shows the project's folder",
      !!shownFolder,
      shownFolder || "no folder on the Overview",
    );
    if (shellMode) {
      const open = page.getByTestId("folder-open");
      const hasOpen = (await open.count()) === 1;
      must("Open folder is on the Overview", hasOpen, hasOpen ? "" : "no Open folder button");
      offset = logSize(shellLog);
      const beforeFolder = await page.url();
      await open.click();
      const h = await handoffSince(offset, (x) => x.kind === "folder");
      check(
        "Open folder hands the project's folder to the file manager",
        !!h && sameFolder(h.target, shownFolder),
        h ? `${h.target} (shown: ${shownFolder})` : shellSaid(shellLog, offset),
      );
      const note = page.getByTestId("folder-note");
      const noteText = (await note.count()) === 1 ? await note.innerText() : "";
      check("Open folder shows no error", !/did not open/i.test(noteText), noteText || "no note");
      await stays(beforeFolder, "Open folder");
    } else
      skip(
        "Open folder hands the project's folder to the file manager",
        "no shell (--attach): a browser has no Open folder",
      );
    await shot("overview after open folder");

    // Settings → Sandbox: the "Get Docker Desktop" link, a link the app itself names.
    await page.getByRole("link", { name: "Settings", exact: true }).first().click();
    const dockerLink = page.getByTestId("sandbox-docker-link");
    await dockerLink.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const sandboxState = await api("GET", "/sandbox")
      .then((s) => s.state)
      .catch(() => "?");
    if ((await dockerLink.count()) === 1) {
      await shot("settings sandbox");
      offset = logSize(shellLog);
      const beforeDocker = await page.url();
      await dockerLink.click();
      await backToPage();
      if (shellMode) {
        const h = await handoffSince(
          offset,
          (x) => x.kind === "browser" && x.target === DOCKER_DESKTOP_URL,
        );
        check(
          '"Get Docker Desktop" hands docker.com to the system browser',
          !!h,
          h ? `${h.via}: ${h.target}` : shellSaid(shellLog, offset),
        );
        await stays(beforeDocker, "Get Docker Desktop");
      } else
        skip('"Get Docker Desktop" hands docker.com to the system browser', "no shell (--attach)");
    } else {
      await shot("settings without the docker link");
      check(
        '"Get Docker Desktop" hands docker.com to the system browser',
        false,
        `no link on Settings → Sandbox (sandbox state ${sandboxState}; it shows only while Docker is not installed)`,
        { required: sandboxState === "not_installed" },
      );
    }
    await shot("end");
    check(
      "the page threw no uncaught error",
      pageErrors.length === 0,
      pageErrors.slice(0, 5).join(" | ") || "none",
      { required: false },
    );
  } catch (e) {
    if (!(e instanceof Stop))
      check(
        "the check ran to its end",
        false,
        e instanceof Error ? (e.stack ?? e.message) : String(e),
      );
    // What the window's page showed at the stop, and on the runner the whole screen too (a
    // dialog of the shell's, a window that never came, are outside the page).
    const label = `stopped: ${e instanceof Stop ? e.message : "an error"}`;
    if (shot) await shot(label).catch((err) => console.log(`no screenshot at the stop: ${err}`));
    if (shellMode) console.log(desktopScreenshot(path.join(out, `99-${slug(label)}-desktop.png`)));
  } finally {
    try {
      client?.close();
    } catch {
      // closed
    }
    if (shellMode) await stopApp(app, daemon);
    await link?.close();
    if (link) result.linkPageRequests = link.hits;
    for (const [from, to] of [
      [shellLog, "desktop-shell.log"],
      [daemonLog, "daemon-shell.log"],
      [path.join(home, "bench", "model-calls.jsonl"), "model-calls.jsonl"],
    ])
      if (existsSync(from)) copyFileSync(from, path.join(out, to));
  }
  result.endedAt = new Date().toISOString();
  writeFileSync(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const title = shellMode
    ? "Desktop window check (installed app, Windows)"
    : "Desktop window check (attached page, no shell)";
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(title, checks));
  const failed = checks.filter((c) => !c.ok && !c.skipped && c.required !== false);
  console.log(
    `${failed.length ? `${failed.length} required check(s) failed` : "every required check passed"}; screenshots, logs and result.json in ${out}`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

/** An extra link at the window's bottom left (the page itself has none of these kinds). */
function injectLinkScript(id, href, target) {
  return `(() => {
    for (const old of document.querySelectorAll("[data-testid=" + ${JSON.stringify(JSON.stringify(id))} + "]")) old.remove();
    const a = document.createElement("a");
    a.id = ${JSON.stringify(id)};
    a.setAttribute("data-testid", ${JSON.stringify(id)});
    a.href = ${JSON.stringify(href)};
    ${target ? `a.target = ${JSON.stringify(target)}; a.rel = "noreferrer";` : ""}
    a.textContent = "window check: " + ${JSON.stringify(id)};
    Object.assign(a.style, { position: "fixed", left: "16px", bottom: "16px", zIndex: "2147483647", background: "#ffeb3b", color: "#000", padding: "8px 12px", font: "16px sans-serif" });
    document.body.appendChild(a);
    return true;
  })()`;
}

/** Quit as the tray's Quit does (POST /shutdown), then end the app's process tree. */
async function stopApp(app, daemon) {
  if (daemon) {
    try {
      await fetch(`${daemon.url}/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      await until(
        "the daemon to stop",
        15_000,
        500,
        async () => !(await healthy(daemon).catch(() => false)),
      );
    } catch (e) {
      console.log(`the daemon did not stop by itself: ${e.message}`);
    }
  }
  if (app && app.exitCode === null && app.pid) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    else app.kill();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
