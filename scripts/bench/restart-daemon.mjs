#!/usr/bin/env node
import path from "node:path";
// Restart only the daemon of a test bench, on the same home, port, provider and --env values
// (to test what survives a restart). The UI dev server keeps running.
//   node scripts/bench/restart-daemon.mjs --name <n> [--hard] [--env KEY=VAL ...]
// --hard ends the daemon's process group without asking it to quit (a crash, a power cut).
// --env adds or replaces failure-injection values for the new start.
// The daemon gets a new token on every start; bench.json is updated, and a page opened with
// recorder.cjs's openApp reloads with it by itself, as the desktop shell reloads its window
// (reconnect(page, name) does it at once; openApp(name, { reconnect: false }) keeps the old
// token, which gets 401). The new daemon runs under supervise.mjs, as start.mjs starts it.
import {
  envPairs,
  fail,
  isAlive,
  killTree,
  parseArgs,
  readBench,
  startDaemon,
  stopDaemon,
  writeBench,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.name || args.name === true) fail("--name <n> is required");
const bench = readBench(args.name);
const stopped = args.hard
  ? `daemon: group ended without asking (${(await killTree(bench.pids.daemon, { hard: true })) ? "gone" : "STILL ALIVE"})`
  : await stopDaemon(bench);
if (isAlive(bench.pids.daemon))
  fail(`the old daemon (pid ${bench.pids.daemon}) is still alive: ${stopped}`);
const env = { ...(bench.env ?? {}), ...envPairs(args.env) };
const daemon = await startDaemon({
  dir: path.dirname(bench.logs.daemon),
  home: bench.home,
  provider: bench.provider,
  port: bench.daemonPort,
  extra: env,
});
const next = {
  ...bench,
  token: daemon.token,
  daemonUrl: daemon.url,
  env,
  pids: { ...bench.pids, daemon: daemon.pid },
  daemonNodePid: daemon.nodePid,
  restarts: [
    ...(bench.restarts ?? []),
    { at: new Date().toISOString(), hard: !!args.hard, stopped },
  ],
};
delete next.stoppedAt;
writeBench(args.name, next);
console.log(
  `bench ${args.name}: ${stopped}; new daemon pid ${daemon.pid} at ${daemon.url} (new token in bench.json; call reconnect(page, "${args.name}") in an open page)`,
);
