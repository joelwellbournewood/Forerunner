import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { TriedEvidence } from "@forerunner/critic";
import { errorMessage, ForerunnerError, join, stripAnsi } from "@forerunner/platform";
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
/** A command the brief says keeps running (a watcher) is stopped after this long. */
export const COMMAND_KEEPS_RUNNING_MS = 5_000;
/** A server gets this long to listen, and each call this long to be answered. */
export const SERVER_START_MS = 15_000;
export const SERVER_CALL_MS = 5_000;
/** Output kept per try for the evidence. */
const OUTPUT_CHARS = 1500;
/** The marker the driver prints its result after. */
const RESULT_MARK = "@@FR-TRY@@";
/**
 * A try leaves no Python bytecode caches in the task's folder, and what it prints is read, not
 * shown in a terminal: no colour (the container never gets the host's FORCE_COLOR; the process
 * sandbox drops it). What a program colours anyway is stripped from the evidence (`stripAnsi`).
 */
const TRY_ENV: Record<string, string> = { PYTHONDONTWRITEBYTECODE: "1", NO_COLOR: "1" };

/**
 * Where the try ran and how far it was kept off the network, in words for the evidence. The
 * container has no network (`--network none`). The process sandbox only points the proxy
 * settings at a proxy that refuses every connection (ADR 0007): a program that ignores them,
 * as Node's own `http` and `fetch` do, still reaches the network, so it does not say "off".
 */
export function whereWords(sandbox: Sandbox): string {
  return sandbox.kind === "container"
    ? "in the task's Docker container, the network off"
    : sandbox.kind === "process"
      ? "on this computer, not in a container (a program that ignores proxy settings can still reach the network)"
      : "in the task's sandbox, the network off";
}

export async function runTries(plan: TryPlan, ctx: TryRunContext): Promise<TryRunOutcome> {
  const out: TryRunOutcome = { tried: [], notTried: [] };
  if (!plan.commands.length && !plan.servers.length) return out;
  const before = snapshot(ctx.root);
  try {
    for (const c of plan.commands) {
      stopIfAborted(ctx.signal);
      const r = await tryCommand(c, ctx);
      stopIfAborted(ctx.signal);
      if ("tried" in r) out.tried.push(r.tried);
      else out.notTried.push(r.notTried);
    }
    for (const s of plan.servers) {
      stopIfAborted(ctx.signal);
      const r = await tryServer(s, ctx);
      stopIfAborted(ctx.signal);
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

/**
 * A stopped review (Stop, a session's end, Quit) stops its try: what the stop cut short is not
 * a problem of the work ("it exited with code null"), and the runner handles the stop.
 */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new ForerunnerError("killed", "the review was stopped while the work was tried");
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
  let ran: Awaited<ReturnType<Sandbox["run"]>>;
  try {
    ran = await ctx.sandbox.run(programArgv(c.argv, ctx.node), {
      env: TRY_ENV,
      timeoutMs: c.keepsRunning ? COMMAND_KEEPS_RUNNING_MS : COMMAND_TRY_TIMEOUT_MS,
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
  // What the person and the critic read of it: plain text, whatever the program printed.
  const r = { ...ran, stdout: stripAnsi(ran.stdout), stderr: stripAnsi(ran.stderr) };
  const missing = notInstalled(c.argv[0] ?? "", r.code, r.stderr);
  if (missing) return { notTried: `${c.target} was not tried: ${missing}` };
  const dep = missingDependency(`${r.stderr}\n${r.stdout}`, ctx.root);
  if (dep) return { notTried: `${c.target} was not tried: ${dep}` };
  const problems: string[] = [];
  // A watcher still running when it was stopped did what the brief says it does.
  const keptRunning = r.timedOut && c.keepsRunning;
  if (r.timedOut && !keptRunning)
    problems.push(`it did not finish within ${COMMAND_TRY_TIMEOUT_MS / 1000} s`);
  else if (!r.timedOut && r.code !== 0 && !c.expectsError) {
    const err = errorLine(r.stderr) ?? errorLine(r.stdout);
    problems.push(`it exited with code ${r.code}${err ? `: ${err}` : ""}`);
  }
  const lines = [
    `ran ${c.target} (from ${c.source}) ${whereWords(ctx.sandbox)}`,
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
    keptRunning
      ? `it kept running, as the brief says; it was stopped after ${COMMAND_KEEPS_RUNNING_MS / 1000} s`
      : r.timedOut
        ? "stopped: it ran out of time"
        : `exit ${r.code} in ${r.durationMs} ms`,
    ...(r.stdout.trim() ? ["output:", clip(r.stdout.trimEnd())] : ["output: (nothing)"]),
    ...(r.stderr.trim() ? ["[stderr]", clip(r.stderr.trimEnd())] : []),
    ...(c.expectsError && !r.timedOut && r.code !== 0 ? ["(the brief expects an error here)"] : []),
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
      notTried: `${s.target} was not tried: ${missing ?? `the try did not finish (${firstLine(stripAnsi(d.error ?? r.stderr)) || (r.timedOut ? "it ran out of time" : `exit ${r.code}`)})`}`,
    };
  }
  const program = s.argv[0] ?? "node";
  const log = stripAnsi(d.log ?? "").trim();
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
            `started ${s.target} (from ${s.source}) ${whereWords(ctx.sandbox)}`,
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
  // A problem that stops a person (a crash, a 5xx, an answer the brief says is wrong) blocks;
  // a named route that answers 4xx where the brief says nothing of its answer is weighed.
  const problems: { text: string; blocking: boolean }[] = [];
  const lines = [`started ${s.target} (from ${s.source}) ${whereWords(ctx.sandbox)}; it listened`];
  for (const call of d.calls ?? []) {
    const route = s.routes.find((x) => x.path === call.path);
    const named = route?.documented ? " (named in the brief)" : "";
    if (call.error) {
      lines.push(`GET ${call.path}${named} -> no answer (${firstLine(stripAnsi(call.error))})`);
      problems.push({ text: `GET ${call.path} did not answer`, blocking: true });
      continue;
    }
    const body = stripAnsi(call.body ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    const status = call.status ?? 0;
    const judged = route ? judgeAnswer(route, status) : { note: "" };
    lines.push(
      `GET ${call.path}${named} -> ${call.status} ${(call.type ?? "").split(";")[0]}${body ? `: ${body}` : ""}${judged.note}`,
    );
    if (judged.problem)
      problems.push({
        text: `GET ${call.path} ${judged.problem.text}`,
        blocking: judged.problem.blocking,
      });
    else if (status >= 500 && !judged.note)
      problems.push({ text: `GET ${call.path} answered ${status}`, blocking: true });
  }
  if (s.skippedRoutes.length)
    lines.push(`not called: ${s.skippedRoutes.join(", ")} (the try calls GET routes only)`);
  if (d.exitedDuring) {
    const err = errorLine(log);
    problems.push({
      text: `it stopped while it was being called (exit ${d.exitedDuring.code ?? d.exitedDuring.signal})${err ? `: ${err}` : ""}`,
      blocking: true,
    });
  }
  if (log) lines.push("its output:", clip(log));
  if (problems.length && !s.expected) return { notTried: notHeld(s, problems[0]?.text ?? "") };
  // The blocking problem first: it is the one the critic's finding names.
  problems.sort((a, b) => Number(b.blocking) - Number(a.blocking));
  lines.push(...problems.map((p) => `problem: ${p.text}`));
  return {
    tried: {
      kind: "server",
      what: `started ${s.target} and called it as a person would`,
      target: s.target,
      ok: problems.length === 0,
      blocking: problems.some((p) => p.blocking),
      output: lines.join("\n"),
      screenshots: [],
    },
  };
}

/**
 * A route's answer against what the brief says of it (`ServerRoute.expect`): the status it
 * names, or an error. A 401 or 403 is the try's own call when the brief calls the route with a
 * token. A named route that answers 4xx with nothing said is a smaller problem, weighed by the
 * critic (it may be a later task's); 5xx is judged by the caller.
 */
function judgeAnswer(
  route: ServerTry["routes"][number],
  status: number,
): { note: string; problem?: { text: string; blocking: boolean } } {
  const expect = route.expect;
  if (expect && "status" in expect) {
    if (status === expect.status) return { note: ` (the brief expects ${expect.status})` };
    return {
      note: "",
      problem: {
        text: `answered ${status}, and the brief says it answers ${expect.status}`,
        blocking: true,
      },
    };
  }
  if (expect && "error" in expect) {
    if (status >= 400 && status < 500) return { note: " (the brief expects it to refuse)" };
    if (status < 400)
      return {
        note: "",
        problem: { text: `answered ${status}, and the brief says it refuses`, blocking: true },
      };
    return { note: "" };
  }
  if (route.withCredentials && (status === 401 || status === 403))
    return { note: " (the brief calls it with a token or a login; the try sends none)" };
  if (route.documented && status >= 400 && status < 500)
    return { note: "", problem: { text: `answered ${status}`, blocking: false } };
  return { note: "" };
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

/** A program the sandbox does not have: `docker exec` answers 126 or 127, Windows 9009, with these words. */
function notInstalled(program: string, code: number | null, stderr: string): string | null {
  if (
    ((code === 126 || code === 127) &&
      /executable file not found|not found|no such file/i.test(stderr)) ||
    // Windows: `python3` that is only the Microsoft Store's alias ("Python was not found; run
    // without arguments to install from the Microsoft Store"), or a name cmd does not know.
    (code === 9009 && /was not found|is not recognized/i.test(stderr))
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
      try {
        rmSync(join(root, ...f.split("/")), { force: true });
      } catch {
        // a file the sandbox's user owns: named, not removed
      }
    } else if (was !== sig) changed.push(f);
  }
  return { created, changed };
}

/** What a test run may rewrite in the person's folder and is put back as it was. */
const KEPT_AS_IT_WAS = ["go.mod", "go.sum", "Cargo.lock", "Cargo.toml"];

/**
 * Keeps the task's folder as the work left it while the review runs the project's tests in it
 * (C-3): `cargo test` writes Cargo.lock, `go test` can rewrite go.mod and go.sum, a test can
 * write its output next to it. The returned function removes what was created meanwhile, puts
 * back the files above as they were, and says in a line what it did, for the check's output.
 */
export function holdFolder(root: string): () => string | null {
  const before = snapshot(root);
  const kept = new Map<string, string | null>();
  for (const f of KEPT_AS_IT_WAS) {
    try {
      kept.set(f, readFileSync(join(root, f), "utf8"));
    } catch {
      kept.set(f, null);
    }
  }
  return () => {
    const left = leftBehind(root, before);
    const putBack: string[] = [];
    for (const [f, text] of kept) {
      if (text === null || !left.changed.includes(f)) continue;
      try {
        if (readFileSync(join(root, f), "utf8") !== text) {
          writeFileSync(join(root, f), text);
          putBack.push(f);
        }
      } catch {
        // unreadable now: named as changed below
      }
    }
    // A kept file that was there is put back or has its content still (only its time moved).
    const changed = left.changed.filter((f) => typeof kept.get(f) !== "string");
    const lines = [
      ...(left.created.length
        ? [`the test run wrote ${left.created.slice(0, 5).join(", ")}; removed again`]
        : []),
      ...(putBack.length ? [`the test run changed ${putBack.join(", ")}; put back as it was`] : []),
      ...(changed.length
        ? [`the test run changed ${changed.slice(0, 5).join(", ")} in the task's folder`]
        : []),
    ];
    return lines.length ? lines.join("\n") : null;
  };
}

/** The line the guard reports the server's end on, in its standard error. */
const GUARD_MARK = "@@FR-GUARD@@";

/**
 * The server driver (CommonJS, so it runs whatever the folder's package type is): it reads its
 * job from standard input, starts the server with PORT set to a free port, waits until it
 * accepts a connection on that port or one its code names (ports already in use before it
 * started are not counted), calls each route with GET over loopback, stops the server and its
 * children, and prints the result after the marker. It runs inside the task's sandbox, so the
 * server and the calls share the sandbox's network: the loopback only.
 *
 * The server never outlives the driver, however the driver ends (rule 4). It is started by a
 * guard (this file with `--guard`), which leads a process group of its own and whose standard
 * input is a pipe from the driver that is never written. When the driver is killed (Stop, the
 * session's end, the sandbox's time limit: the sandbox kills only the driver), that pipe closes
 * and the guard kills its group: the server and whatever it started. When the server ends by
 * itself, the guard says how on its standard error and takes the server's children with it.
 * On Windows the sandbox's kill takes the driver's whole tree, guard and server included.
 */
export const SERVER_DRIVER = String.raw`"use strict";
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const http = require("http");
const MARK = "${RESULT_MARK}";
const GUARD = "${GUARD_MARK}";
if (process.argv[2] === "--guard") guard();
else {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => {
    let cfg;
    try { cfg = JSON.parse(raw); } catch (e) { return done({ error: "bad job: " + e.message }); }
    main(cfg).catch((e) => done({ error: String((e && e.message) || e) }));
  });
}
function guard() {
  const win = process.platform === "win32";
  const argv = JSON.parse(process.env.FR_TRY_ARGV || "[]");
  delete process.env.FR_TRY_ARGV;
  let child = null;
  let ending = false;
  const end = () => {
    if (ending) return;
    ending = true;
    if (win) {
      if (child && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return process.exit(0);
    }
    try { process.kill(-process.pid, "SIGKILL"); } catch (e) {
      try { if (child) child.kill("SIGKILL"); } catch (e2) {}
      process.exit(0);
    }
  };
  const report = (r) => {
    if (ending) return;
    process.stderr.write("\n" + GUARD + JSON.stringify(r) + "\n", end);
  };
  // The driver ended: nothing may stay of what it started.
  process.stdin.on("end", end);
  process.stdin.on("error", end);
  process.stdin.resume();
  child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  child.on("error", (e) => report({ spawnError: e.message }));
  child.on("exit", (code, signal) => report({ exit: { code, signal } }));
}
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
  // The guard starts the server; its standard input stays open as long as this driver lives.
  const child = spawn(process.execPath, [__filename, "--guard"], {
    env: Object.assign({}, process.env, { PORT: String(port), FR_TRY_ARGV: JSON.stringify(argv) }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: !win,
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("error", (e) => { spawnError = e.message; });
  // "close": the guard has ended and everything it said has been read, its report included.
  child.on("close", (code, signal) => {
    let said = {};
    log = log.split("\n").filter((line) => {
      if (line.indexOf(GUARD) !== 0) return true;
      try { said = Object.assign(said, JSON.parse(line.slice(GUARD.length))); } catch (e) {}
      return false;
    }).join("\n");
    if (said.spawnError) spawnError = said.spawnError;
    exited = said.exit || { code, signal };
  });
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
