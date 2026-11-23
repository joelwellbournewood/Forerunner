import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * l4-cred-screens, run L4 (L4-creds-29, design §5): what the intake card and the critic's
 * calibration say counts with the plural the number needs ("2 milestones, 5 tasks, 3 docs"),
 * never "(s)". The string literals of these files are read as written (comments left out).
 */
const FILES = ["../src/session/intake.ts", "../src/jobs/calibration.ts"];

describe("l4-cred-screens, run L4: no '(s)' plurals (L4-creds-29)", () => {
  for (const rel of FILES) {
    it(`${rel.replace("../src/", "")} writes no "(s)" in a string literal`, () => {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      const offending = source
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => !/^(\/\/|\/\*|\*)/.test(line))
        .filter(({ line }) => /["'`][^"'`]*\w\(s\)[^"'`]*["'`$]/.test(line));
      expect(offending).toEqual([]);
    });
  }
});
