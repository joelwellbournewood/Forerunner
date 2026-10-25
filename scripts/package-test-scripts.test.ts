import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";

// Handover item 7 of 2026-10-24: `vitest run --project unit --dir test` inside a package matched
// nothing, because the root config's include globs are relative to the repository root, so
// `pnpm --filter <pkg> test` printed "No test files found" and passed vacuously. Every package
// test script that targets the unit project now runs vitest from the workspace root with the
// package's own test directory as the path filter, which matches on Windows and Linux.
const root = process.cwd();

function workspaceDirs(): string[] {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s*-\s*"([^"]+)"/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -2);
      for (const name of readdirSync(join(root, parent))) {
        if (statSync(join(root, parent, name)).isDirectory()) dirs.push(`${parent}/${name}`);
      }
    } else {
      dirs.push(glob);
    }
  }
  return dirs.filter((dir) => existsSync(join(root, dir, "package.json")));
}

describe("package test scripts run the unit project on their own test directory", () => {
  const unitScripts = workspaceDirs()
    .map((dir) => ({
      dir,
      script: JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).scripts?.test,
    }))
    .filter(
      (entry): entry is { dir: string; script: string } =>
        typeof entry.script === "string" && entry.script.includes("--project unit"),
    );

  it("finds the packages whose test script runs the unit project", () => {
    expect(unitScripts.length).toBeGreaterThanOrEqual(14);
  });

  it.each(unitScripts.map(({ dir, script }) => [dir, script]))(
    "%s runs vitest from the workspace root with its test directory as the path filter",
    (dir, script) => {
      expect(script).toBe(`pnpm -w exec vitest run --project unit ${dir}/test`);
      expect(existsSync(join(root, dir, "test"))).toBe(true);
    },
  );
});
