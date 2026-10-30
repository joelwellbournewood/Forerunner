import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, dirname, join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_RUNTIME_MARKER,
  REPO_REGISTRY_MARKER,
  resolveRegistryDir,
  SEED_MANIFEST,
  seedRegistry,
} from "../src/registry/loader.ts";

/**
 * The runtime a desktop installer carries (ADR 0092) sits in a read-only directory (Program
 * Files, /usr/lib), but specialist proposals and promotions write into the registry. The
 * installed runtime uses `<data>/registry`, seeded from its own copy at every start.
 */

function put(root: string, rel: string, text: string): void {
  const file = join(root, ...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const read = (root: string, rel: string) => readFileSync(join(root, ...rel.split("/")), "utf8");

describe("the installed runtime's registry", () => {
  it("is the data directory, seeded from the bundle, when the checkout carries runtime.json", () => {
    const env = { FORERUNNER_HOME: "/home/me/.fr" };
    const root = "/opt/forerunner/runtime";
    const marker = join(root, REPO_REGISTRY_MARKER);
    const start = join(root, "packages", "runtime", "src", "registry");

    const dev = resolveRegistryDir(env, { startDir: start, exists: (p) => p === marker });
    expect(dev).toEqual({ dir: join(root, "evals", "registry"), source: "repo" });

    const installed = resolveRegistryDir(env, {
      startDir: start,
      exists: (p) => p === marker || p === join(root, BUNDLED_RUNTIME_MARKER),
    });
    expect(installed).toEqual({
      dir: join(appDirs({ env }).data, "registry"),
      source: "bundled",
      seed: join(root, "evals", "registry"),
    });

    // FORERUNNER_REGISTRY_DIR still wins.
    expect(resolveRegistryDir({ ...env, FORERUNNER_REGISTRY_DIR: "/x/reg" }).source).toBe("env");
  });

  it("copies the bundle, keeps what the install added, updates and drops the bundle's own files", () => {
    const base = mkdtempSync(join(tmpdir(), "fr-registry-seed-"));
    const seed = join(base, "seed");
    const dir = join(base, "data", "registry");
    put(seed, "specialists/coder/specialist.md", "coder v1");
    put(seed, "specialists/old/specialist.md", "old");
    put(seed, "principals/pm.md", "pm v1");

    expect(seedRegistry(seed, dir)).toEqual({ copied: 3, removed: 0 });
    expect(read(dir, "specialists/coder/specialist.md")).toBe("coder v1");
    expect(JSON.parse(read(dir, SEED_MANIFEST)).files).toEqual([
      "principals/pm.md",
      "specialists/coder/specialist.md",
      "specialists/old/specialist.md",
    ]);

    // The install proposes and promotes specialists: files only it has.
    put(dir, "proposed/helper/specialist.md", "proposal");
    put(dir, "specialists/helper/specialist.md", "promoted");

    // A new release changes one file and drops another.
    put(seed, "specialists/coder/specialist.md", "coder v2");
    rmSync(join(seed, "specialists", "old", "specialist.md"));
    expect(seedRegistry(seed, dir)).toEqual({ copied: 2, removed: 1 });
    expect(read(dir, "specialists/coder/specialist.md")).toBe("coder v2");
    expect(existsSync(join(dir, "specialists", "old", "specialist.md"))).toBe(false);
    expect(read(dir, "proposed/helper/specialist.md")).toBe("proposal");
    expect(read(dir, "specialists/helper/specialist.md")).toBe("promoted");
  });

  it("never removes a path that walks out of the registry, even when the manifest names one", () => {
    const base = mkdtempSync(join(tmpdir(), "fr-registry-seed-"));
    const seed = join(base, "seed");
    const dir = join(base, "data", "registry");
    put(seed, "principals/pm.md", "pm");
    put(base, "data/precious.txt", "keep");
    put(dir, SEED_MANIFEST, JSON.stringify({ files: ["../precious.txt", "principals/pm.md"] }));
    expect(seedRegistry(seed, dir).removed).toBe(0);
    expect(read(base, "data/precious.txt")).toBe("keep");
  });
});
