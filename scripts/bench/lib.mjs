// Shared helpers of the test bench scripts (start, stop, restart-daemon). See README.md.
// Node only, no dependencies; works on Windows and Linux (paths via node:path).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const IS_WINDOWS = process.platform === "win32";

/** Where benches live: FRBENCH_ROOT, else <tmp>/frbench (/tmp/frbench on Linux). */
export function benchRoot() {
  return process.env.FRBENCH_ROOT || path.join(tmpdir(), "frbench");
}

export function benchDir(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name ?? ""))
    fail(`--name must be letters, digits, . _ - (got ${JSON.stringify(name)})`);
  return path.join(benchRoot(), name);
}

export function benchFile(name) {
  return path.join(benchDir(name), "bench.json");
}

export function readBench(name) {
  const file = benchFile(name);
  if (!existsSync(file))
    fail(`no bench named ${name} (${file} does not exist); start one with scripts/bench/start.mjs`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeBench(name, bench) {
  writeFileSync(benchFile(name), `${JSON.stringify(bench, null, 2)}\n`);
}

export function fail(message) {
  console.error(`bench: ${message}`);
  process.exit(1);
}

/** `--key value` and `--flag` options; `--env` may repeat. */
export function parseArgs(argv) {
  const out = { env: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith("--") ? next : true;
    if (value !== true) i++;
    if (key === "env") out.env.push(String(value));
    else out[key] = value;
  }
  return out;
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/** Poll `check` until it returns a truthy value or `ms` passes; returns the value or null. */
export async function waitFor(check, ms, everyMs = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await check();
      if (v) return v;
    } catch {
      // not yet
    }
    await sleep(everyMs);
  }
  return null;
}

/**
 * Start a detached process group (POSIX) or a hidden process (Windows) with its output
 * appended to `logFile`; returns its pid. The group lets stop.mjs end its children too.
 */
export function spawnLogged(argv, { cwd, env, logFile }) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  return child.pid;
}

/** End a process and everything it started; true when it is gone. `hard`: SIGKILL at once. */
export async function killTree(pid, { graceMs = 5000, hard = false } = {}) {
  if (!isAlive(pid)) return true;
  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return (await waitFor(() => !isAlive(pid), graceMs, 200)) !== null;
  }
  const signal = (sig) => {
    try {
      process.kill(-pid, sig); // the whole process group
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // gone
      }
    }
  };
  if (!hard) {
    signal("SIGTERM");
    if ((await waitFor(() => !isAlive(pid), graceMs, 200)) !== null) return true;
  }
  signal("SIGKILL");
  return (await waitFor(() => !isAlive(pid), 3000, 200)) !== null;
}

/** GET/POST against the daemon with its token; returns { status, body }. */
export async function daemonFetch(bench, method, route, body) {
  const res = await fetch(`${bench.daemonUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${bench.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // plain text
  }
  return { status: res.status, body: parsed };
}

/** Variables the bench never passes to the app (task rules): the environment's own tokens. */
export const NEVER_PASSED = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTHROPIC_BASE_URL",
  "FORERUNNER_GITHUB_TOKEN",
];
/** Model credentials, passed only to `--provider bench-live`. */
export const MODEL_CREDENTIALS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "FORERUNNER_ANTHROPIC_KEY",
  "FORERUNNER_SUBSCRIPTION_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

export function daemonEnv({ home, provider, extra }) {
  const env = { ...process.env };
  for (const k of NEVER_PASSED) delete env[k];
  if (provider !== "bench-live") for (const k of MODEL_CREDENTIALS) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith("FORERUNNER_")) delete env[k];
  env.FORERUNNER_HOME = home;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

/** `KEY=VAL` pairs from repeated --env options. */
export function envPairs(list) {
  const out = {};
  for (const item of list) {
    const eq = item.indexOf("=");
    if (eq <= 0) fail(`--env expects KEY=VALUE (got ${item})`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

/** `none`: no --provider flag, the install's own behaviour (no key in the vault: no model). */
export function daemonArgv(provider, port) {
  return [
    process.execPath,
    "--import",
    "tsx",
    path.join("packages", "runtime", "src", "cli", "main.ts"),
    "daemon",
    ...(provider === "none" ? [] : ["--provider", provider]),
    "--port",
    String(port),
  ];
}

/** Start the daemon, wait for daemon.json and /health; returns { pid, nodePid, token, url }. */
export async function startDaemon({ dir, home, provider, port, extra }) {
  const runtimeFile = path.join(home, "runtime", "daemon.json");
  const before = existsSync(runtimeFile) ? readFileSync(runtimeFile, "utf8") : "";
  const logFile = path.join(dir, "daemon.log");
  writeFileSync(
    logFile,
    `\n=== bench start ${new Date().toISOString()} provider=${provider} port=${port}\n`,
    { flag: "a" },
  );
  const pid = spawnLogged(daemonArgv(provider, port), {
    cwd: REPO,
    env: daemonEnv({ home, provider, extra }),
    logFile,
  });
  const info = await waitFor(async () => {
    if (!isAlive(pid)) throw new Error("exited");
    if (!existsSync(runtimeFile)) return null;
    const raw = readFileSync(runtimeFile, "utf8");
    if (raw === before) return null;
    const d = JSON.parse(raw);
    const res = await fetch(`${d.url}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? d : null;
  }, 120_000);
  if (!info) {
    const tail = readFileSync(logFile, "utf8").split("\n").slice(-25).join("\n");
    await killTree(pid);
    fail(
      `the daemon did not come up within 120 s (pid ${pid}${isAlive(pid) ? "" : ", exited"}). Last lines of ${logFile}:\n${tail}`,
    );
  }
  return { pid, nodePid: info.pid, token: info.token, url: info.url };
}

/** Ask the daemon to quit (POST /shutdown, the app's Quit), then end its process group. */
export async function stopDaemon(b) {
  const pid = b.pids?.daemon;
  if (!isAlive(pid)) return "daemon: not running";
  let asked = "not asked";
  try {
    const r = await daemonFetch(b, "POST", "/shutdown", {});
    asked = `POST /shutdown -> ${r.status}`;
  } catch (e) {
    asked = `POST /shutdown failed (${e.message})`;
  }
  const gone = (await waitFor(() => !isAlive(b.daemonNodePid ?? pid), 10_000, 250)) !== null;
  const killed = await killTree(pid);
  return `daemon: ${asked}; ${gone ? "quit by itself" : "did not quit in 10 s"}; group ${killed ? "ended" : "STILL ALIVE"}`;
}
