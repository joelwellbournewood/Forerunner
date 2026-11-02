// Helpers for Playwright scripts that drive a test bench (see README.md):
//   const { openApp, step, api } = require("<repo>/scripts/bench/recorder.cjs");
//   const { browser, page } = await openApp("smoke");
//   const text = await step(page, "home");          // steps/NN-home.png + NN-home.txt
//   const projects = await api("smoke", "GET", "/projects");
// Console errors, page errors, failed requests and responses >= 400 are appended to
// <bench>/steps/problems.jsonl with the step they happened after.
"use strict";
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function benchRoot() {
  return process.env.FRBENCH_ROOT || path.join(os.tmpdir(), "frbench");
}

/** The bench's bench.json (written by start.mjs, updated by restart-daemon.mjs). */
function bench(name) {
  const file = path.join(benchRoot(), name, "bench.json");
  if (!fs.existsSync(file))
    throw new Error(`no bench named ${name}: ${file} does not exist (scripts/bench/start.mjs)`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function stepsDir(name) {
  const dir = path.join(benchRoot(), name, "steps");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Playwright: FRBENCH_PLAYWRIGHT (a path), a normal require, else the global install. */
function loadPlaywright() {
  const tries = [];
  if (process.env.FRBENCH_PLAYWRIGHT) tries.push(process.env.FRBENCH_PLAYWRIGHT);
  tries.push("playwright");
  try {
    tries.push(
      path.join(
        execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
        "playwright",
      ),
    );
  } catch {
    // no npm on PATH
  }
  for (const t of tries) {
    try {
      return require(t);
    } catch {
      // next
    }
  }
  throw new Error(
    `playwright not found (tried ${tries.join(", ")}); set FRBENCH_PLAYWRIGHT or NODE_PATH`,
  );
}

const state = new WeakMap(); // page -> { name, lastStep }

function stripToken(url) {
  return String(url).replace(/([?&]token=)[^&]+/g, "$1[REDACTED]");
}

function problem(name, page, rec) {
  const s = state.get(page);
  const line = { time: new Date().toISOString(), afterStep: s ? s.lastStep : null, ...rec };
  fs.appendFileSync(path.join(stepsDir(name), "problems.jsonl"), `${JSON.stringify(line)}\n`);
}

function injection(b) {
  // What the desktop shell injects from daemon.json (apps/desktop/src-tauri/src/inject.rs).
  return `window.__FORERUNNER__ = ${JSON.stringify({ daemonUrl: b.daemonUrl, daemonToken: b.token, installId: `bench-${b.name}` })};`;
}

/**
 * Open the bench's UI in Chromium. The browser profile (local storage, cookies) lives in
 * <bench>/browser-profile and survives between scripts, as the desktop app's window storage
 * survives between launches; one openApp per bench at a time. Options: headed (default false),
 * viewport ({width,height}, default 1400x900), path (default "/"), freshProfile (wipe the
 * profile first), profile: false (a throwaway context, e.g. a second window). Returns
 * { browser, context, page }; browser.close() ends it.
 */
async function openApp(name, opts = {}) {
  const b = bench(name);
  const { chromium } = loadPlaywright();
  const viewport = opts.viewport || { width: 1400, height: 900 };
  let browser;
  let context;
  if (opts.profile === false) {
    browser = await chromium.launch({ headless: !opts.headed });
    context = await browser.newContext({ viewport });
  } else {
    const profile = path.join(benchRoot(), name, "browser-profile");
    if (opts.freshProfile) fs.rmSync(profile, { recursive: true, force: true });
    context = await chromium.launchPersistentContext(profile, { headless: !opts.headed, viewport });
    browser = context;
  }
  await context.addInitScript(injection(b));
  const page = context.pages()[0] || (await context.newPage());
  state.set(page, { name, lastStep: null });
  page.on("console", (msg) => {
    if (msg.type() === "error")
      problem(name, page, {
        kind: "console",
        text: msg.text().slice(0, 2000),
        location: msg.location(),
      });
  });
  page.on("pageerror", (err) =>
    problem(name, page, {
      kind: "pageerror",
      message: String(err.message).slice(0, 2000),
      stack: String(err.stack || "").slice(0, 2000),
    }),
  );
  page.on("requestfailed", (req) => {
    const failure = req.failure() ? req.failure().errorText : "failed";
    // A fetch the page itself aborted (a screen left, a stream closed) is not a problem;
    // FRBENCH_RECORD_ABORTED=1 records those too.
    if (/ERR_ABORTED/.test(failure) && process.env.FRBENCH_RECORD_ABORTED !== "1") return;
    problem(name, page, {
      kind: "requestfailed",
      method: req.method(),
      url: stripToken(req.url()),
      failure,
    });
  });
  page.on("response", async (res) => {
    if (res.status() < 400) return;
    let body = "";
    try {
      body = (await res.text()).slice(0, 1000);
    } catch {
      // streamed or gone
    }
    problem(name, page, {
      kind: "http",
      status: res.status(),
      method: res.request().method(),
      url: stripToken(res.url()),
      body,
    });
  });
  await page.goto(`${b.uiUrl}${opts.path || "/"}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  return { browser, context, page };
}

/**
 * On a home whose setup was never finished the app shows the setup assistant on every screen;
 * this presses "Set up later" as a person without keys would. True when it did.
 */
async function skipSetup(page) {
  const text = await page.evaluate(() => document.body.innerText);
  if (!/Set up Forerunner/.test(text)) return false;
  const later = page.getByRole("button", { name: "Set up later", exact: true });
  if (!(await later.count())) return false;
  await later.first().click();
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  return true;
}

/** After restart-daemon.mjs: give the open page the new token and reload it. */
async function reconnect(page, name) {
  const b = bench(name);
  await page.context().addInitScript(injection(b));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
}

function nextNumber(dir) {
  let max = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d+)-/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Record the screen: steps/NN-<label>.png (full page) and NN-<label>.txt (the visible text);
 * returns the text. Waits briefly for the network to settle first. Numbers continue across
 * scripts on the same bench; steps/index.jsonl lists every step with its URL.
 */
async function step(page, label, opts = {}) {
  const s = state.get(page);
  if (!s) throw new Error("step(): open the page with openApp() first");
  await page
    .waitForLoadState("networkidle", { timeout: opts.settleMs ?? 3000 })
    .catch(() => undefined);
  if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
  const dir = stepsDir(s.name);
  const n = String(nextNumber(dir)).padStart(2, "0");
  const safe =
    String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "step";
  const base = path.join(dir, `${n}-${safe}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  const text = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync(`${base}.txt`, text);
  fs.appendFileSync(
    path.join(dir, "index.jsonl"),
    `${JSON.stringify({ n: Number(n), label, url: page.url(), time: new Date().toISOString(), png: `${base}.png`, txt: `${base}.txt` })}\n`,
  );
  s.lastStep = `${n}-${safe}`;
  return text;
}

class BenchApiError extends Error {
  constructor(method, route, status, body) {
    super(
      `${method} ${route} -> ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`.slice(
        0,
        1000,
      ),
    );
    this.status = status;
    this.body = body;
  }
}

/** Call the daemon as the UI does; returns { status, body } and never throws for a status. */
async function apiRaw(name, method, route, body) {
  const b = bench(name);
  const res = await fetch(`${b.daemonUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${b.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // plain text
  }
  return { status: res.status, body: parsed };
}

/** Call the daemon; returns the parsed body, throws BenchApiError (status, body) at >= 400. */
async function api(name, method, route, body) {
  const r = await apiRaw(name, method, route, body);
  if (r.status >= 400) throw new BenchApiError(method, route, r.status, r.body);
  return r.body;
}

/** Every line of the model-call log, optionally filtered by role ("intake", "specialist", ...). */
function modelCalls(name, role) {
  const file = bench(name).modelCallLog;
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => !role || r.role === role);
}

const KINDS = ["intake", "specialist", "critic", "chat", "unknown"];

/**
 * Calls and USD by kind (intake, specialist, critic, chat, unknown) from model-call log lines.
 * `usd` is what the daemon wrote on each line from the app's price table; a line without it
 * (the stand-in's `fake-*` rungs, or a log written before prices were logged) counts as
 * unpriced, with its models named.
 */
function callSummary(records) {
  const byKind = {};
  let usd = 0;
  let priced = 0;
  const unpriced = {};
  for (const r of records) {
    const kind = KINDS.includes(r.role) ? r.role : "unknown";
    const k = byKind[kind] ?? { calls: 0, usd: 0, models: [] };
    k.calls += 1;
    if (!k.models.includes(r.model)) k.models.push(r.model);
    if (typeof r.usd === "number") {
      k.usd += r.usd;
      usd += r.usd;
      priced += 1;
    } else unpriced[r.model] = (unpriced[r.model] ?? 0) + 1;
    byKind[kind] = k;
  }
  return { calls: records.length, usd, priced, unpriced, byKind };
}

/** The summary as lines a person reads; `cap` (USD) adds what is left or that it is over. */
function formatCallSummary(s, { title = "model calls", cap } = {}) {
  const money = (n) => `USD ${n.toFixed(3)}`;
  const lines = [
    `${title}: ${s.calls} call${s.calls === 1 ? "" : "s"}, ${money(s.usd)}${s.priced < s.calls ? ` (${s.calls - s.priced} without a price)` : ""}`,
  ];
  for (const kind of KINDS) {
    const k = s.byKind[kind];
    if (!k) continue;
    lines.push(
      `  ${kind.padEnd(10)} ${String(k.calls).padStart(4)} call${k.calls === 1 ? " " : "s"}  ${money(k.usd)}  (${k.models.join(", ")})`,
    );
  }
  const none = Object.entries(s.unpriced);
  if (none.length)
    lines.push(`  without a price: ${none.map(([m, n]) => `${m} x${n}`).join(", ")}`);
  if (typeof cap === "number")
    lines.push(
      s.usd >= cap
        ? `OVER the cap of ${money(cap)} by ${money(s.usd - cap)}`
        : `cap ${money(cap)}: ${money(cap - s.usd)} left`,
    );
  return lines.join("\n");
}

/** The last `n` lines of the daemon's log. */
function daemonLog(name, n = 80) {
  const file = bench(name).logs.daemon;
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").slice(-n).join("\n") : "";
}

/** Every recorded problem (console errors, failed requests, responses >= 400). */
function problems(name) {
  const file = path.join(stepsDir(name), "problems.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Poll `fn` (sync or async) until it returns a truthy value; throws after `ms`. */
async function until(fn, ms = 60_000, everyMs = 1000, what = "condition") {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(
    `timed out after ${ms} ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`,
  );
}

// --- Setup through the API (for steps that are not under test) -----------------------------

/**
 * Create a project with a brief, wait for the intake's plan and approve it, as the UI's New
 * project + Inbox "approve" do. Returns { projectId, tasks }. Throws with the intake's state
 * when the plan does not arrive (FORERUNNER_BENCH_INTAKE=malformed makes it fail on purpose).
 */
async function createPlannedProject(
  name,
  { project, goal, brief, approve = true, timeoutMs = 90_000 },
) {
  const created = await api(name, "POST", "/projects", {
    name: project,
    goal,
    brief,
    intake: true,
  });
  const projectId = created.id;
  const pending = await until(
    async () => {
      const s = await api(name, "GET", `/projects/${encodeURIComponent(projectId)}/intake`);
      if (s.state === "failed") throw new Error(`intake failed: ${s.error}`);
      return s.state === "pending" ? s : null;
    },
    timeoutMs,
    1000,
    "the intake's plan",
  );
  if (approve) {
    const inbox = await api(name, "GET", "/inbox");
    const card = inbox.requests.find((r) => r.id === pending.requestId);
    if (!card) throw new Error(`intake request ${pending.requestId} is not in the Inbox`);
    await api(name, "POST", `/requests/${encodeURIComponent(card.id)}/answer`, {
      version: card.version,
      answer: "approve",
    });
    await until(
      async () =>
        (await api(name, "GET", `/projects/${encodeURIComponent(projectId)}/tasks`)).length > 0,
      30_000,
      500,
      "the plan's tasks",
    );
  }
  return {
    projectId,
    requestId: pending.requestId,
    tasks: await api(name, "GET", `/projects/${encodeURIComponent(projectId)}/tasks`),
  };
}

/** Start a session as the project's Start button does; returns the start's answer (POST /sessions). */
async function startSession(name, projectId, reason = "started by a bench script") {
  const me = await api(name, "GET", "/me");
  return api(name, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId,
    trigger: "manual",
    reason,
  });
}

/** Wait until a session has ended; returns its view (status completed, stopped, failed or killed). */
async function waitForSession(name, sessionId, ms = 300_000) {
  return until(
    async () => {
      const s = await api(name, "GET", `/sessions/${encodeURIComponent(sessionId)}`);
      return ["completed", "stopped", "failed", "killed"].includes(s.status) ? s : null;
    },
    ms,
    1000,
    `session ${sessionId} to end`,
  );
}

/** The folder a project without a repository works in (U-037): <home>/data/projects/<id>/workspace. */
function workspaceOf(name, projectId) {
  return path.join(bench(name).projectsRoot, projectId, "workspace");
}

module.exports = {
  createPlannedProject,
  startSession,
  waitForSession,
  workspaceOf,
  skipSetup,
  openApp,
  step,
  api,
  apiRaw,
  reconnect,
  bench,
  modelCalls,
  callSummary,
  formatCallSummary,
  daemonLog,
  problems,
  until,
  BenchApiError,
};
