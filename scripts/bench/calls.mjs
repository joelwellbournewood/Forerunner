#!/usr/bin/env node
// What a bench's model calls cost: calls and USD by kind (intake, specialist, critic, chat),
// from the model-call log, whose every line carries `usd` from the app's own price table.
//   node scripts/bench/calls.mjs --name <n> [--cap <usd>] [--json]
//   node scripts/bench/calls.mjs --log <model-calls.jsonl> [--cap <usd>] [--json]
// With --cap the exit code is 3 once the total reaches the cap, so a live run can stop there.
// See README.md.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fail, parseArgs, readBench } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { callSummary, formatCallSummary } = require("./recorder.cjs");

const args = parseArgs(process.argv.slice(2));
const name = typeof args.name === "string" ? args.name : null;
const file = typeof args.log === "string" ? args.log : name ? readBench(name).modelCallLog : null;
if (!file) fail("--name <bench> or --log <model-calls.jsonl> is required");
const cap = args.cap === undefined ? undefined : Number(args.cap);
if (cap !== undefined && !(Number.isFinite(cap) && cap > 0))
  fail(`--cap expects an amount in USD (got ${args.cap})`);

const records = existsSync(file)
  ? readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const summary = callSummary(records);
if (args.json) console.log(JSON.stringify({ file, ...summary, cap: cap ?? null }, null, 2));
else
  console.log(
    formatCallSummary(summary, { title: `model calls${name ? ` of bench ${name}` : ""}`, cap }),
  );
if (cap !== undefined && summary.usd >= cap) process.exitCode = 3;
