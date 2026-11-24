#!/usr/bin/env node
// GitHub unreachable for one home (w8-two-homes, wave 8, W8-homes-4): under D9 the 2026-11-02
// "cut one PC's database connection" became "GitHub unreachable for one home". Each bench with
// a stand-in for GitHub (its own, or another's through --githost-shared) reaches it through a
// proxy of its own (github-proxy.mjs); this closes or opens that proxy, so only this bench's
// daemon finds GitHub unreachable (a refused connection) and the other home is unaffected.
//   node scripts/bench/cut.mjs <bench> github off|on
// Waits until the proxy says the new state (github-proxy.json), then prints it.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { benchDir, fail, isAlive, readBench, waitFor } from "./lib.mjs";

const [name, what, state] = process.argv.slice(2);
if (!name || what !== "github" || !["off", "on"].includes(state ?? ""))
  fail("usage: node scripts/bench/cut.mjs <bench> github off|on");
const bench = readBench(name);
const dir = benchDir(name);
const proxyPid = bench.pids?.githubProxy;
if (!proxyPid)
  fail(`bench ${name} has no proxy to GitHub (start it with --githost or --githost-shared)`);
if (!isAlive(proxyPid))
  fail(`the proxy to GitHub of bench ${name} is not running (pid ${proxyPid})`);
const cutFile = path.join(dir, "github-cut");
if (state === "off") writeFileSync(cutFile, `${new Date().toISOString()}\n`);
else rmSync(cutFile, { force: true });
const stateFile = path.join(dir, "github-proxy.json");
const now = await waitFor(
  () => {
    if (!existsSync(stateFile)) return null;
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    return s.state === state ? s : null;
  },
  10_000,
  100,
);
if (!now) fail(`the proxy to GitHub of bench ${name} did not turn ${state} within 10 s`);
console.log(
  `bench ${name}: GitHub ${state === "off" ? "unreachable for this home only" : "reachable again"} (${now.url} -> ${now.target})`,
);
