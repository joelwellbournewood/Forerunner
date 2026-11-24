#!/usr/bin/env node
// Stop a test bench: exactly the processes start.mjs recorded (and their children).
//   node scripts/bench/stop.mjs --name <n> [--keep-ui] [--clean]
// The daemon is asked to quit first (POST /shutdown, what the app's Quit does), then its
// process group is ended; the UI dev server's group, the proxy to GitHub and the stand-in for
// GitHub this bench started are ended. A stand-in another bench started (--githost-shared) is
// that bench's to stop. Nothing is killed by name.
// `--clean` (w8-two-homes): after every recorded process is gone (checked by PID; the exit code
// is 1 when one is not), the bench's home, logs, stand-in data and browser profile are removed;
// steps/ (the screenshots, their texts and the result files) stays.
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  benchDir,
  benchRoot,
  isAlive,
  killTree,
  parseArgs,
  readBench,
  stopDaemon,
  writeBench,
} from "./lib.mjs";

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
for (const [label, pid] of [
  ["github proxy", bench.pids?.githubProxy],
  ["githost", bench.pids?.githost],
])
  if (pid)
    report.push(
      isAlive(pid)
        ? `${label}: ${(await killTree(pid)) ? "ended" : "STILL ALIVE"}`
        : `${label}: not running`,
    );
const others = (bench.githost?.sharedWith ?? []).filter((n) => n !== args.name);
if (bench.pids?.githost && others.length)
  report.push(`the stand-in for GitHub was also used by bench ${others.join(", ")}`);
writeBench(args.name, { ...bench, stoppedAt: new Date().toISOString() });

let exit = 0;
if (args.clean) {
  const left = Object.entries(bench.pids ?? {}).filter(
    ([label, pid]) => !(label === "ui" && args["keep-ui"]) && isAlive(pid),
  );
  if (bench.daemonNodePid && isAlive(bench.daemonNodePid))
    left.push(["daemon (node)", bench.daemonNodePid]);
  if (left.length) {
    report.push(`not cleaned: still running ${left.map(([l, p]) => `${l} ${p}`).join(", ")}`);
    exit = 1;
  } else {
    const dir = benchDir(args.name);
    const removed = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "steps" || entry === "bench.json") continue;
      rmSync(path.join(dir, entry), { recursive: true, force: true });
      removed.push(entry);
    }
    // A home given with --home is removed only when it lies under the bench root; one elsewhere
    // is the person's to remove (it may be a folder they meant to keep).
    const root = path.resolve(benchRoot());
    const home = bench.home ? path.resolve(bench.home) : null;
    const underRoot = home?.startsWith(`${root}${path.sep}`);
    if (home && !home.startsWith(`${path.resolve(dir)}${path.sep}`)) {
      if (underRoot) {
        rmSync(home, { recursive: true, force: true });
        removed.push(home);
      } else report.push(`kept the home ${home} (outside ${root})`);
    }
    report.push(`cleaned: no process left; removed ${removed.length} entries, kept steps/`);
  }
}
console.log(`bench ${args.name}: ${report.join("; ")}`);
process.exit(exit);
