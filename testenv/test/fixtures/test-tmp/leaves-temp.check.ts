import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform/paths";
import { expect, it } from "vitest";

// Run by testenv/test/test-tmp.test.ts in a child vitest (vitest.config.ts here), never by a
// suite. It does what many tests do: makes temp folders and leaves them. What it saw goes to
// FR_TMP_GUARD_OUT, a folder outside the temp folder, for the parent to check.
const out = process.env.FR_TMP_GUARD_OUT as string;

// A process the test starts makes a folder of its own and prints where.
const CHILD = [
  "const fs = require('node:fs');",
  "const os = require('node:os');",
  "const p = require('node:path');", // path-ok: the script of a plain node child, which cannot import @forerunner/platform
  "const d = fs.mkdtempSync(p.join(os.tmpdir(), 'fr-tmpguard-child-'));",
  "fs.writeFileSync(p.join(d, 'left.txt'), 'x');",
  "process.stdout.write(JSON.stringify({ tmp: os.tmpdir(), dir: d }));",
].join("\n");

it("makes temp folders, starts a process that makes one, and removes none", () => {
  expect(out).toBeTruthy();
  const dir = mkdtempSync(join(tmpdir(), "fr-tmpguard-left-"));
  mkdirSync(join(dir, "deeper", "still deeper"), { recursive: true });
  writeFileSync(join(dir, "deeper", "still deeper", "left.txt"), "x");
  const child = JSON.parse(execFileSync(process.execPath, ["-e", CHILD], { encoding: "utf8" }));
  writeFileSync(
    join(out, "seen.json"),
    JSON.stringify({
      tmp: tmpdir(),
      env: { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP },
      dir,
      child,
    }),
  );
});

it("a test that points TMPDIR, TMP and TEMP elsewhere itself gets what it set", () => {
  const own = join(out, "own temp");
  mkdirSync(own, { recursive: true });
  const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  try {
    process.env.TMPDIR = own;
    process.env.TMP = own;
    process.env.TEMP = own;
    expect(tmpdir()).toBe(own);
    const dir = mkdtempSync(join(tmpdir(), "fr-tmpguard-own-"));
    const child = JSON.parse(execFileSync(process.execPath, ["-e", CHILD], { encoding: "utf8" }));
    writeFileSync(join(out, "own.json"), JSON.stringify({ dir, child }));
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
