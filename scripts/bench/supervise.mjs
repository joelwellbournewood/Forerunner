#!/usr/bin/env node
// The bench's stand-in for the desktop shell's daemon supervisor (apps/desktop/src-tauri:
// actions.rs `handle_daemon_exit`, restart.rs `decide_after_exit`). start.mjs and
// restart-daemon.mjs run the daemon under it:
//   node scripts/bench/supervise.mjs --home <home> [--bench <bench.json>] -- <daemon argv ...>
// The daemon asks for a restart by writing <home>/runtime/restart.json and exiting with 86
// (packages/runtime/src/daemon/restart.ts): finishing setup with a new credential does that, as
// "Update and restart" does. Then the supervisor removes the request, starts the daemon again
// with the same argv and environment, and once it answers puts its new token and pid into
// bench.json (recorder.cjs's open pages reload with it, as the desktop shell reloads its
// window). Any other exit ends the supervisor with the daemon's code. Every decision is a line
// of daemon.log (its stdout), beginning "=== bench supervisor". Before, the bench had none: a
// finished setup left the daemon gone and the UI "not connected" (gh1 and live2 walks).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** `RESTART_EXIT_CODE` of packages/runtime/src/daemon/restart.ts. */
const RESTART_EXIT_CODE = 86;
/** The desktop shell's limits (restart.rs): one relaunch in a row, two for a rollback. */
const MAX_RESTARTS = 1;
/** A relaunched daemon that stays up this long resets the count (restart.rs STABLE_AFTER_SECS). */
const STABLE_AFTER_MS = 30_000;

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) {
  console.error("supervise.mjs: give the daemon's argv after --");
  process.exit(2);
}
const opts = {};
for (let i = 0; i < sep; i += 2) opts[argv[i].replace(/^--/, "")] = argv[i + 1];
const daemonArgv = argv.slice(sep + 1);
if (!opts.home) {
  console.error("supervise.mjs: --home <home> is required");
  process.exit(2);
}
const runtimeDir = path.join(opts.home, "runtime");
const requestFile = path.join(runtimeDir, "restart.json");
const daemonFile = path.join(runtimeDir, "daemon.json");

const say = (line) => console.log(`=== bench supervisor ${new Date().toISOString()}: ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

function restartRequest() {
  try {
    const r = JSON.parse(read(requestFile));
    return r && r.schema === 1 && typeof r.targetVersion === "string" ? r : null;
  } catch {
    return null;
  }
}

/**
 * Once the relaunched daemon answers: its token, URL and pid into bench.json (when there is
 * one), with the restart recorded, so `recorder.cjs` and the bench scripts reach it.
 */
async function announce(before, reason) {
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const raw = read(daemonFile);
    if (raw && raw !== before) {
      try {
        const d = JSON.parse(raw);
        const res = await fetch(`${d.url}/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          if (opts.bench && existsSync(opts.bench)) {
            const b = JSON.parse(readFileSync(opts.bench, "utf8"));
            const next = {
              ...b,
              token: d.token,
              daemonUrl: d.url,
              daemonNodePid: d.pid,
              restarts: [
                ...(b.restarts ?? []),
                { at: new Date().toISOString(), hard: false, by: "supervisor", reason },
              ],
            };
            writeFileSync(opts.bench, `${JSON.stringify(next, null, 2)}\n`);
          }
          say(`the daemon is back at ${d.url} (pid ${d.pid}); bench.json has its new token`);
          return;
        }
      } catch {
        // not yet
      }
    }
    await sleep(500);
  }
  say("the restarted daemon did not answer within 120 s");
}

let child = null;
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(sig, () => {
    stopping = true;
    try {
      child?.kill(sig);
    } catch {
      // gone
    }
  });

let consecutive = 0;
let reason = null;
for (;;) {
  const before = read(daemonFile);
  const started = Date.now();
  child = spawn(daemonArgv[0], daemonArgv.slice(1), {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  if (reason !== null) void announce(before, reason);
  const { code, signal } = await new Promise((resolve) =>
    child.once("exit", (c, s) => resolve({ code: c, signal: s })),
  );
  if (stopping) process.exit(code ?? 0);
  const request = code === RESTART_EXIT_CODE ? restartRequest() : null;
  if (request) {
    if (Date.now() - started >= STABLE_AFTER_MS) consecutive = 0;
    const limit = request.reason === "rollback" ? MAX_RESTARTS + 1 : MAX_RESTARTS;
    if (consecutive >= limit) {
      say(
        `the daemon asked for a restart (${request.reason}) ${consecutive + 1} times in a row without staying up; not started again`,
      );
      process.exit(code);
    }
    consecutive += 1;
    rmSync(requestFile, { force: true });
    reason = request.reason;
    say(
      `the daemon exited with ${code} and asked for a restart (${request.reason}); starting it again, as the desktop shell does`,
    );
    continue;
  }
  say(
    `the daemon exited with ${code ?? `signal ${signal}`}${code === RESTART_EXIT_CODE ? " without a restart request" : ""}; not started again`,
  );
  process.exit(code ?? 1);
}
