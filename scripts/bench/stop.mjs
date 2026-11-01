#!/usr/bin/env node
// Stop a test bench: exactly the processes start.mjs recorded (and their children).
//   node scripts/bench/stop.mjs --name <n> [--keep-ui]
// The daemon is asked to quit first (POST /shutdown, what the app's Quit does), then its
// process group is ended; the UI dev server's group is ended. Nothing is killed by name.
import { isAlive, killTree, parseArgs, readBench, stopDaemon, writeBench } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.name || args.name === true) {
  console.error("bench: --name <n> is required");
  process.exit(1);
}
const bench = readBench(args.name);
const report = [];

report.push(await stopDaemon(bench));
if (!args["keep-ui"]) {
  const ui = bench.pids?.ui;
  report.push(
    isAlive(ui) ? `ui: ${(await killTree(ui)) ? "ended" : "STILL ALIVE"}` : "ui: not running",
  );
}
writeBench(args.name, { ...bench, stoppedAt: new Date().toISOString() });
console.log(`bench ${args.name}: ${report.join("; ")}`);
