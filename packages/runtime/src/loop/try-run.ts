import { readdirSync, rmSync, statSync } from "node:fs";
import type { TriedEvidence } from "@forerunner/critic";
import { errorMessage, join } from "@forerunner/platform";
import type { Sandbox } from "../sandbox/types.ts";
import { type CommandTry, type ServerTry, TRY_FOLDER, type TryPlan } from "./try-plan.ts";

/**
 * Runs what `planTries` chose in the task's sandbox lease (ADR 0110): the container when Docker
 * is ready (always for a full review, ADR 0101), the process sandbox otherwise, with the network
 * off and a time limit. A command runs with its sample input; a server is started by a small
 * driver inside the same sandbox, which waits for it to listen, calls its routes over the
 * sandbox's own loopback and stops it. What happened is the critic's verified evidence
 * (`TriedEvidence`), and what could not be tried is said with the reason.
 */
export interface TryRunContext {
  sandbox: Sandbox;
  /** The task's folder on the host (the sandbox's worktree). */
  root: string;
  /**
   * How `node` is started in this sandbox: `node` in the container (the runner image has it),
   * the daemon's own Node in the process sandbox (an installed app has no `node` on the PATH).
   */
  node: string;
  signal?: AbortSignal;
}

export interface TryRunOutcome {
  tried: TriedEvidence[];
  notTried: string[];
}

/** A command gets this long. */
export const COMMAND_TRY_TIMEOUT_MS = 30_000;
/** A server gets this long to listen, and each call this long to be answered. */
export const SERVER_START_MS = 15_000;
export const SERVER_CALL_MS = 5_000;
/** Output kept per try for the evidence. */
const OUTPUT_CHARS = 1500;
/** The marker the driver prints its result after. */
const RESULT_MARK = "@@FR-TRY@@";
/** A try leaves no Python bytecode caches in the task's folder. */
const TRY_ENV: Record<string, string> = { PYTHONDONTWRITEBYTECODE: "1" };

/** Where the try ran, in words for the evidence. */
export function whereWords(sandbox: Sandbox): string {
  return sandbox.kind === "container"
    ? "in the task's Docker container"
    : sandbox.kind === "process"
      ? "in the process sandbox on this computer"
      : "in the task's sandbox";
}

export async function runTries(plan: TryPlan, ctx: TryRunContext): Promise<TryRunOutcome> {
  const out: TryRunOutcome = { tried: [], notTried: [] };
  if (!plan.commands.length && !plan.servers.length) return out;
  const before = snapshot(ctx.root);
  try {
    for (const c of plan.commands) {
      if (ctx.signal?.aborted) break;
      const r = await tryCommand(c, ctx);
      if ("tried" in r) out.tried.push(r.tried);
      else out.notTried.push(r.notTried);
    }
    for (const s of plan.servers) {
      if (ctx.signal?.aborted) break;
      const r = await tryServer(s, ctx);
      if ("tried" in r) out.tried.push(r.tried);
      else out.notTried.push(r.notTried);
    }
  } finally {
    // The try's own files go, and so do files the tried work wrote while it was tried: they are
    // the try's output, not the task's work, and the next task must not build on them.
    rmSync(join(ctx.root, TRY_FOLDER), { recursive: true, force: true });
    const left = leftBehind(ctx.root, before);
    if (left.created.length || left.changed.length) {
      const last = out.tried.at(-1);
      const note = [
        ...(left.created.length
          ? [`the try wrote ${left.created.slice(0, 5).join(", ")}; removed again`]
          : []),
        ...(left.changed.length
          ? [`the try changed ${left.changed.slice(0, 5).join(", ")} in the task's folder`]
          : []),
      ].join("\n");
      if (last) last.output = `${last.output}\n${note}`;
    }
  }
  return out;
}

async function writeSamples(c: CommandTry, sandbox: Sandbox): Promise<void> {
  for (const s of c.samples) {
    if (typeof s.content === "string") await sandbox.writeFile(s.path, s.content);
    else
      for (const [name, text] of Object.entries(s.content))
        await sandbox.writeFile(`${s.path}/${name}`, text);
  }
}

function programArgv(argv: readonly string[], node: string): string[] {
  const [program, ...rest] = argv;
  return [program === "node" ? node : (program ?? node), ...rest];
}

async function tryCommand(
  c: CommandTry,
  ctx: TryRunContext,
): Promise<{ tried: TriedEvidence } | { notTried: string }> {
  try {
    await writeSamples(c, ctx.sandbox);
  } catch (e) {
    return {
      notTried: `${c.target} was not tried: its sample input could not be written (${firstLine(errorMessage(e))})`,
    };
  }
  let r: Awaited<ReturnType<Sandbox["run"]>>;
  try {
    r = await ctx.sandbox.run(programArgv(c.argv, ctx.node), {
      env: TRY_ENV,
      timeoutMs: COMMAND_TRY_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      ...(c.input !== undefined ? { input: c.input } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return {
      notTried: `${c.target} was not tried: ${cannotStart(c.argv[0] ?? "", errorMessage(e))}`,
    };
  }
  const missing = notInstalled(c.argv[0] ?? "", r.code, r.stderr);
  if (missing) return { notTried: `${c.target} was not tried: ${missing}` };
  const dep = missingDependency(`${r.stderr}\n${r.stdout}`, ctx.root);
  if (dep) return { notTried: `${c.target} was not tried: ${dep}` };
  const problems: string[] = [];
  if (r.timedOut) problems.push(`it did not finish within ${COMMAND_TRY_TIMEOUT_MS / 1000} s`);
  else if (r.code !== 0 && !c.expectsError) {
    const err = errorLine(r.stderr) ?? errorLine(r.stdout);
    problems.push(`it exited with code ${r.code}${err ? `: ${err}` : ""}`);
  }
  const lines = [
    `ran ${c.target} (from ${c.source}) ${whereWords(ctx.sandbox)}, the network off`,
    ...c.samples.flatMap((s) => [
      `${s.stands}${typeof s.content === "string" ? ":" : ""}`,
      ...(typeof s.content === "string"
        ? s.content
            .split("\n")
            .filter(Boolean)
            .slice(0, 6)
            .map((l) => `  ${l}`)
        : []),
    ]),
    r.timedOut ? "stopped: it ran out of time" : `exit ${r.code} in ${r.durationMs} ms`,
    ...(r.stdout.trim() ? ["output:", clip(r.stdout.trimEnd())] : ["output: (nothing)"]),
    ...(r.stderr.trim() ? ["[stderr]", clip(r.stderr.trimEnd())] : []),
    ...(c.expectsError && r.code !== 0 ? ["(the brief expects an error here)"] : []),
    ...problems.map((p) => `problem: ${p}`),
  ];
  return {
    tried: {
      kind: "command",
      what: `ran ${c.target} as a person would${c.samples.length || c.input !== undefined ? ", with sample input" : ""}`,
      target: c.target,
      ok: problems.length === 0,
      blocking: problems.length > 0,
      output: lines.join("\n"),
      screenshots: [],
    },
  };
}

/** What the server driver reports. */
interface DriverResult {
  started?: boolean;
  port?: number;
  spawnError?: string | null;
  exit?: { code: number | null; signal: string | null } | null;
  exitedDuring?: { code: number | null; signal: string | null } | null;
  calls?: { path: string; status?: number; type?: string; body?: string; error?: string }[];
  log?: string;
  error?: string;
}

async function tryServer(
  s: ServerTry,
  ctx: TryRunContext,
): Promise<{ tried: TriedEvidence } | { notTried: string }> {
  const driver = `${TRY_FOLDER}/serve.cjs`;
  try {
    await ctx.sandbox.writeFile(driver, SERVER_DRIVER);
  } catch (e) {
    return {
      notTried: `${s.target} was not tried: the try could not be prepared (${firstLine(errorMessage(e))})`,
    };
  }
  const config = {
    argv: s.argv.map((a, i) => (i === 0 && a === "node" ? "$NODE" : a)),
    ports: s.ports,
    routes: s.routes.map((r) => r.path),
    startMs: SERVER_START_MS,
    callMs: SERVER_CALL_MS,
  };
  let r: Awaited<ReturnType<Sandbox["run"]>>;
  try {
    r = await ctx.sandbox.run([ctx.node, driver], {
      env: TRY_ENV,
      input: JSON.stringify(config),
      timeoutMs: SERVER_START_MS + SERVER_CALL_MS * s.routes.length + 15_000,
      maxOutputBytes: 256 * 1024,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return { notTried: `${s.target} was not tried: ${cannotStart("node", errorMessage(e))}` };
  }
  const at = r.stdout.lastIndexOf(RESULT_MARK);
  let d: DriverResult;
  try {
    d = at >= 0 ? (JSON.parse(r.stdout.slice(at + RESULT_MARK.length).trim()) as DriverResult) : {};
  } catch {
    d = {};
  }
  if (at < 0 || d.error) {
    const missing = notInstalled("node", r.code, r.stderr);
    return {
      notTried: `${s.target} was not tried: ${missing ?? `the try did not finish (${firstLine(d.error ?? r.stderr) || (r.timedOut ? "it ran out of time" : `exit ${r.code}`)})`}`,
    };
  }
  const program = s.argv[0] ?? "node";
  const log = (d.log ?? "").trim();
  if (!d.started) {
    if (d.spawnError)
      return { notTried: `${s.target} was not tried: ${cannotStart(program, d.spawnError)}` };
    const dep = missingDependency(log, ctx.root);
    if (dep) return { notTried: `${s.target} was not tried: ${dep}` };
    const code = d.exit?.code;
    if (d.exit && code !== 0) {
      const err = errorLine(log);
      const problem = `it stopped before it listened (exit ${code ?? d.exit.signal})${err ? `: ${err}` : ""}`;
      if (!s.expected) return { notTried: notHeld(s, problem) };
      return {
        tried: {
          kind: "server",
          what: `started ${s.target} as a person would`,
          target: s.target,
          ok: false,
          blocking: true,
          output: [
            `started ${s.target} (from ${s.source}) ${whereWords(ctx.sandbox)}, the network off`,
            ...(log ? ["its output:", clip(log)] : []),
            `problem: ${problem}`,
          ].join("\n"),
          screenshots: [],
        },
      };
    }
    return {
      notTried: `${s.target} was not tried: it was started but did not listen on a port within ${SERVER_START_MS / 1000} s, so its routes were not called`,
    };
  }
  const problems: string[] = [];
  const lines = [
    `started ${s.target} (from ${s.source}) ${whereWords(ctx.sandbox)}, the network off; it listened`,
  ];
  for (const call of d.calls ?? []) {
    const route = s.routes.find((x) => x.path === call.path);
    const named = route?.documented ? " (named in the brief)" : "";
    if (call.error) {
      lines.push(`GET ${call.path}${named} -> no answer (${firstLine(call.error)})`);
      problems.push(`GET ${call.path} did not answer`);
      continue;
    }
    const body = (call.body ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    lines.push(
      `GET ${call.path}${named} -> ${call.status} ${(call.type ?? "").split(";")[0]}${body ? `: ${body}` : ""}`,
    );
    const status = call.status ?? 0;
    if (status >= 500 || (route?.documented && status >= 400))
      problems.push(`GET ${call.path} answered ${status}`);
  }
  if (s.skippedRoutes.length)
    lines.push(`not called: ${s.skippedRoutes.join(", ")} (the try calls GET routes only)`);
  if (d.exitedDuring) {
    const err = errorLine(log);
    problems.push(
      `it stopped while it was being called (exit ${d.exitedDuring.code ?? d.exitedDuring.signal})${err ? `: ${err}` : ""}`,
    );
  }
  if (log) lines.push("its output:", clip(log));
  if (problems.length && !s.expected) return { notTried: notHeld(s, problems[0] ?? "") };
  lines.push(...problems.map((p) => `problem: ${p}`));
  return {
    tried: {
      kind: "server",
      what: `started ${s.target} and called it as a person would`,
      target: s.target,
      ok: problems.length === 0,
      blocking: problems.length > 0,
      output: lines.join("\n"),
      screenshots: [],
    },
  };
}

/**
 * What a server only found in the code met (it needs a database, a key, a file of the person's):
 * told, not held against the task, which was not asked to run it.
 */
function notHeld(s: ServerTry, problem: string): string {
  return `${s.target} was started, but ${problem}; the brief says nothing about running it, so this is not held against the task`;
}

/** Why a program could not start, in words: not installed, or the sandbox's own message. */
function cannotStart(program: string, message: string): string {
  if (/ENOENT|not found|No such file|cannot find/i.test(message))
    return `${program === "node" ? "Node.js" : program} is not installed where the work is tried`;
  return `it could not start (${firstLine(message)})`;
}

/** A program the container does not have: `docker exec` answers 126 or 127 with these words. */
function notInstalled(program: string, code: number | null, stderr: string): string | null {
  if (
    (code === 126 || code === 127) &&
    /executable file not found|not found|no such file/i.test(stderr)
  )
    return `${program === "node" ? "Node.js" : program} is not installed where the work is tried`;
  return null;
}

/**
 * A package the work imports that is not installed in the folder ("Cannot find module
 * 'express'", "No module named 'flask'"): the try cannot say anything about the work then. A
 * file of the task's own that is missing is the work's problem, not this.
 */
function missingDependency(text: string, root: string): string | null {
  const node = /Cannot find (?:module|package) '([^']+)'/.exec(text);
  if (node?.[1] && !/^[./]/.test(node[1]))
    return `it needs ${node[1]}, which is not installed in the task's folder`;
  const py = /ModuleNotFoundError: No module named '([^'.]+)/.exec(text);
  if (py?.[1]) {
    const own = [`${py[1]}.py`, py[1], `src/${py[1]}.py`, `src/${py[1]}`].some((p) =>
      exists(join(root, p)),
    );
    if (!own)
      return `it needs the Python package ${py[1]}, which is not installed where the work is tried`;
  }
  return null;
}

/** The line of an output that says what went wrong (an error's name, a traceback's last line). */
function errorLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pick =
    lines.find((l) => /^\w*(Error|Exception)\b[:\s]/.test(l)) ??
    lines.findLast((l) => /\b\w*(Error|Exception)\b/.test(l)) ??
    lines[0];
  return pick ? pick.slice(0, 200) : null;
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 200);
}

function clip(s: string): string {
  return s.length > OUTPUT_CHARS ? `${s.slice(0, OUTPUT_CHARS)}\n[... cut]` : s;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The task folder's files with their size and time, to tell what a try left behind. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= 5000) return;
      // Dot folders (.git, .venv, the try's own), dependencies and caches are not the work.
      if (e === "node_modules" || e === "__pycache__" || e.startsWith(".")) continue;
      const p = join(dir, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 6) walk(p, `${prefix}${e}/`, depth + 1);
      } else out.set(`${prefix}${e}`, `${st.size}:${st.mtimeMs}`);
    }
  };
  walk(root, "", 0);
  return out;
}

function leftBehind(
  root: string,
  before: Map<string, string>,
): { created: string[]; changed: string[] } {
  const after = snapshot(root);
  const created: string[] = [];
  const changed: string[] = [];
  for (const [f, sig] of after) {
    const was = before.get(f);
    if (was === undefined) {
      created.push(f);
      rmSync(join(root, ...f.split("/")), { force: true });
    } else if (was !== sig) changed.push(f);
  }
  return { created, changed };
}

/**
 * The server driver (CommonJS, so it runs whatever the folder's package type is): it reads its
 * job from standard input, starts the server with PORT set to a free port, waits until it
 * accepts a connection on that port or one its code names (ports already in use before it
 * started are not counted), calls each route with GET over loopback, stops the server and its
 * children, and prints the result after the marker. It runs inside the task's sandbox, so the
 * server and the calls share the sandbox's network: the loopback only.
 */
export const SERVER_DRIVER = String.raw`"use strict";
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const http = require("http");
const MARK = "${RESULT_MARK}";
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { return done({ error: "bad job: " + e.message }); }
  main(cfg).catch((e) => done({ error: String((e && e.message) || e) }));
});
function done(r) { process.stdout.write("\n" + MARK + JSON.stringify(r) + "\n", () => process.exit(0)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function open(port) {
  return new Promise((res) => {
    const c = net.connect(port, "127.0.0.1");
    const t = setTimeout(() => { c.destroy(); res(false); }, 400);
    c.once("connect", () => { clearTimeout(t); c.destroy(); res(true); });
    c.once("error", () => { clearTimeout(t); res(false); });
  });
}
function get(port, path, ms) {
  return new Promise((res) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers: { accept: "*/*" } }, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (d) => { if (body.length < 2000) body += d; });
      r.on("end", () => res({ status: r.statusCode, type: String(r.headers["content-type"] || ""), body }));
      r.on("error", (e) => res({ error: e.message }));
    });
    req.setTimeout(ms, () => req.destroy(new Error("no answer within " + ms / 1000 + " s")));
    req.on("error", (e) => res({ error: e.message }));
  });
}
async function main(cfg) {
  const win = process.platform === "win32";
  const port = await freePort();
  const busy = [];
  for (const p of cfg.ports) if (p !== port && (await open(p))) busy.push(p);
  const ports = [port, ...cfg.ports.filter((p) => p !== port && !busy.includes(p))];
  const argv = cfg.argv.map((a) => (a === "$NODE" ? process.execPath : a));
  let log = "";
  const keep = (d) => { log = (log + d).slice(-4000); };
  let exited = null;
  let spawnError = null;
  const child = spawn(argv[0], argv.slice(1), {
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: !win,
    windowsHide: true,
  });
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("error", (e) => { spawnError = e.message; });
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  const kill = () => {
    if (exited || !child.pid) return;
    try {
      if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else process.kill(-child.pid, "SIGKILL");
    } catch (e) {
      try { child.kill("SIGKILL"); } catch (e2) {}
    }
  };
  process.on("exit", kill);
  const until = Date.now() + cfg.startMs;
  let listening = null;
  while (Date.now() < until && !exited && !spawnError) {
    for (const p of ports) if (await open(p)) { listening = p; break; }
    if (listening) break;
    await sleep(150);
  }
  if (!listening) {
    kill();
    for (let i = 0; i < 20 && !exited && !spawnError; i++) await sleep(50);
    return done({ started: false, spawnError, exit: exited, log });
  }
  const calls = [];
  for (const path of cfg.routes) calls.push(Object.assign({ path }, await get(listening, path, cfg.callMs)));
  await sleep(100);
  const exitedDuring = exited;
  kill();
  done({ started: true, port: listening, calls, exitedDuring, log });
}
`;
