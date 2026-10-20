#!/usr/bin/env node
// Kept for older invocations: the emulator run lives in e2e/run.mjs (see e2e/README.md).
// Same behaviour as `pnpm --filter @forerunner/mobile test:emulator`.
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runner = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "e2e", "run.mjs");
try {
  execFileSync(process.execPath, [runner, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (error) {
  process.exit(typeof error.status === "number" ? error.status : 1);
}
