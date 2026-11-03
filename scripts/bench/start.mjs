#!/usr/bin/env node
// Start a test bench: the real daemon on an isolated home plus the real UI dev server.
//   node scripts/bench/start.mjs --name <n> --daemon-port <p> --ui-port <u>
//        [--provider bench|fake|bench-live|none] [--home <dir>] [--fresh] [--env KEY=VAL ...]
//        [--githost <port> [--githost-in-setup]]
// Writes <bench root>/<n>/bench.json { daemonUrl, uiUrl, home, token, pids, ... } and prints it.
// See README.md. Stop with stop.mjs, restart only the daemon with restart-daemon.mjs. The daemon
// runs under supervise.mjs, which starts it again when it asks to restart (exit 86), as the
// desktop shell does; bench.json then gets its new token.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  benchDir,
  benchFile,
  envPairs,
  fail,
  isAlive,
  killTree,
  LIVE_KEY_MISSING,
  liveKey,
  parseArgs,
  portFree,
  REPO,
  readBench,
  spawnLogged,
  startDaemon,
  startGithost,
  storeBenchKey,
  storeGithubToken,
  storeLiveKey,
  waitFor,
  writeBench,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const name = args.name;
const daemonPort = Number(args["daemon-port"]);
const uiPort = Number(args["ui-port"]);
const provider = typeof args.provider === "string" ? args.provider : "bench";
if (!name || name === true) fail("--name <n> is required");
if (!Number.isInteger(daemonPort) || !Number.isInteger(uiPort))
  fail("--daemon-port <p> and --ui-port <u> are required");
if (!["bench", "fake", "bench-live", "bench-api", "none"].includes(provider))
  fail(`--provider must be bench, fake, bench-live, bench-api or none (got ${provider})`);
// `--api-key refused|limited|ok` (U-078): a key-shaped key made here, written straight into the
// home's vault (setup checks a key before it stores one); the stand-in of bench-api answers it
// by its kind. Never with bench-live, whose key is the environment's.
const apiKey = args["api-key"];
if (apiKey !== undefined && !["refused", "limited", "ok"].includes(apiKey))
  fail(`--api-key must be refused, limited or ok (got ${apiKey})`);
if (apiKey !== undefined && provider === "bench-live")
  fail("--api-key is for --provider bench-api (or none); bench-live stores the environment's key");
// The real Messages API needs a key: refused here, before anything starts (not after a wait).
if (provider === "bench-live" && !liveKey()) fail(LIVE_KEY_MISSING);

const dir = benchDir(name);
if (existsSync(benchFile(name))) {
  const old = readBench(name);
  const alive = Object.values(old.pids ?? {}).filter((p) => isAlive(p));
  if (alive.length)
    fail(
      `bench ${name} is already running (pids ${alive.join(", ")}); stop it first: node scripts/bench/stop.mjs --name ${name}`,
    );
}
const home = path.resolve(typeof args.home === "string" ? args.home : path.join(dir, "home"));
if (args.fresh) {
  for (const sub of ["home", "steps", "daemon.log", "ui.log", "githost", "githost.json"])
    rmSync(path.join(dir, sub), { recursive: true, force: true });
  if (typeof args.home === "string") rmSync(home, { recursive: true, force: true });
}
mkdirSync(home, { recursive: true });
mkdirSync(path.join(dir, "steps"), { recursive: true });

const githostPort = args.githost === undefined ? null : Number(args.githost);
if (githostPort !== null && !Number.isInteger(githostPort))
  fail("--githost <port> needs the port of the stand-in for GitHub");
for (const [label, port] of [
  ["daemon", daemonPort],
  ["ui", uiPort],
  ...(githostPort === null ? [] : [["githost", githostPort]]),
])
  if (!(await portFree(port))) fail(`port ${port} (${label}) is in use; pick another`);

const extra = envPairs(args.env);
// `--githost <port>`: a stand-in for GitHub (the fake git host) with an empty and a seeded
// repository; its token goes into the vault and its URL into the config, as `fr setup` does.
let githost = null;
// `--githost-in-setup`: the token is not stored; the person pastes it (bench.json
// `githost.token`) in the setup assistant's GitHub step, which checks it against the stand-in,
// and finishing setup then restarts the daemon (supervise.mjs starts it again).
const githostInSetup = args["githost-in-setup"] === true;
if (githostInSetup && githostPort === null) fail("--githost-in-setup needs --githost <port>");
if (githostPort !== null) {
  console.log(`bench ${name}: starting the stand-in for GitHub on port ${githostPort} ...`);
  githost = await startGithost({ dir, port: githostPort });
  if (githostInSetup) extra.FORERUNNER_GITHUB_API ??= githost.url;
  else storeGithubToken({ dir, home, githost });
}
if (provider === "bench-live") {
  console.log(`bench ${name}: storing the key in the home's vault (fr setup checks it first) ...`);
  storeLiveKey({ dir, home, extra });
}
if (apiKey !== undefined) {
  console.log(`bench ${name}: writing a ${apiKey} API key into the home's vault ...`);
  storeBenchKey({ dir, home, kind: apiKey });
}
console.log(`bench ${name}: starting the daemon (provider ${provider}) on port ${daemonPort} ...`);
const daemon = await startDaemon({ dir, home, provider, port: daemonPort, extra });

console.log(`bench ${name}: starting the UI dev server on port ${uiPort} ...`);
const uiDir = path.join(REPO, "apps", "ui");
const viteBin = path.join(uiDir, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(viteBin)) {
  await killTree(daemon.pid);
  fail(`vite not found at ${viteBin}; run pnpm install`);
}
const uiLog = path.join(dir, "ui.log");
const uiPid = spawnLogged(
  [process.execPath, viteBin, "--port", String(uiPort), "--strictPort", "--host", "127.0.0.1"],
  {
    cwd: uiDir,
    env: {
      ...process.env,
      VITE_DAEMON_URL: daemon.url,
      VITE_DAEMON_TOKEN: daemon.token,
      BROWSER: "none",
    },
    logFile: uiLog,
  },
);
const uiUrl = `http://127.0.0.1:${uiPort}`;
const uiUp = await waitFor(async () => {
  if (!isAlive(uiPid)) throw new Error("exited");
  const res = await fetch(`${uiUrl}/`, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}, 90_000);
if (!uiUp) {
  await killTree(uiPid);
  await killTree(daemon.pid);
  fail(`the UI dev server did not answer on ${uiUrl} within 90 s; see ${uiLog}`);
}

const bench = {
  name,
  daemonUrl: daemon.url,
  uiUrl,
  home,
  token: daemon.token,
  provider,
  // A journey reads this to check structure instead of the stand-in's texts (smoke.cjs).
  live: provider === "bench-live",
  env: extra,
  daemonPort,
  uiPort,
  pids: { daemon: daemon.pid, ui: uiPid, ...(githost ? { githost: githost.pid } : {}) },
  ...(githost
    ? {
        githost: {
          url: githost.url,
          repos: githost.repos,
          // The token to paste in the setup assistant (a stand-in's token, never a real one).
          ...(githostInSetup ? { token: githost.token, inSetup: true } : {}),
        },
      }
    : {}),
  daemonNodePid: daemon.nodePid,
  projectsRoot: path.join(home, "data", "projects"),
  modelCallLog: path.join(home, "bench", "model-calls.jsonl"),
  // bench-api (U-078): every request the Messages API stand-in got, its key named by id only.
  ...(provider === "bench-api"
    ? { apiRequestLog: path.join(home, "bench", "api-requests.jsonl") }
    : {}),
  logs: { daemon: path.join(dir, "daemon.log"), ui: uiLog },
  steps: path.join(dir, "steps"),
  startedAt: new Date().toISOString(),
};
writeBench(name, bench);
writeFileSync(
  path.join(dir, "README.txt"),
  "A Forerunner test bench. See scripts/bench/README.md in the repository.\n",
);
console.log(JSON.stringify(bench, null, 2));
console.log(
  `bench ${name}: ready. Open ${uiUrl} (the token is already in the page). Stop: node scripts/bench/stop.mjs --name ${name}`,
);
