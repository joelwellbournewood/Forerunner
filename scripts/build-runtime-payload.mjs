#!/usr/bin/env node
// The runtime the desktop installers carry (ADR 0092): a Node.js binary, the TypeScript sources
// of @forerunner/runtime and the workspace packages it imports, the specialist registry, and the
// production dependencies in a flat node_modules, laid out like a repository checkout so the
// shell runs it exactly as `pnpm fr` does (`node node_modules/tsx/dist/cli.mjs
// packages/runtime/src/cli/main.ts`). A new user installs the MSI, AppImage or .deb and the app
// starts its own daemon: no git, pnpm, PowerShell or Node.js on the machine.
//
// Layout of <out>:
//   runtime.json                     { schema, version, platform, arch, node, entry }
//   package.json                     the app version (read by packages/runtime/src/version.ts)
//   tsconfig.json                    `paths` for every @forerunner/* import (tsx resolves them)
//   node/node[.exe]                  the Node.js binary that built the payload (or --node)
//   packages/<name>/                 package.json and sources, no tests
//   evals/registry/                  the specialist registry (found by the registry loader)
//   node_modules/                    third-party production dependencies, hoisted, no symlinks
//
// The workspace packages are resolved through tsconfig `paths` rather than node_modules/@forerunner
// links: an installer cannot carry symlinks, and copies under node_modules would load
// @forerunner/runtime twice (capabilities, commands, critic and memory import it back).
//
// Usage: node scripts/build-runtime-payload.mjs [--out <dir>] [--node <path>]
//        (default out: apps/desktop/src-tauri/runtime, which tauri.conf.json bundles)
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_ENTRY = "packages/runtime/src/cli/main.ts";
export const DEFAULT_OUT = ["apps", "desktop", "src-tauri", "runtime"];
/** Directories of a workspace package that never ship. */
const PACKAGE_SKIP = new Set(["test", "node_modules", "scripts", "tsconfig.json"]);
/** Suffixes of files no running process reads (types, source maps). */
const PRUNE_SUFFIXES = [".map", ".d.ts", ".d.mts", ".d.cts", ".tsbuildinfo"];
const PLATFORM_PACKAGE_RE =
  /-(linux|win32|darwin|freebsd|android)-(x64|arm64|ia32|arm)(?:-(gnu|musl|msvc|gnueabihf))?$/;
/** The libc flavour the installers target per OS (glibc on Linux, MSVC on Windows). */
const LIBC = { linux: "gnu", win32: "msvc" };

/**
 * tsconfig `paths` for workspace packages, from each package's `exports` map:
 * `"."` → `@name`, `"./*"` → `@name/*`, `"./x"` → `@name/x`. Targets are relative to the payload
 * root (where tsconfig.json sits).
 */
export function workspacePaths(packages) {
  const paths = {};
  for (const pkg of packages) {
    const exportsMap =
      typeof pkg.exports === "string"
        ? { ".": pkg.exports }
        : (pkg.exports ?? { ".": "./src/index.ts" });
    for (const [key, target] of Object.entries(exportsMap)) {
      if (typeof target !== "string") continue;
      const spec = key === "." ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, "")}`;
      paths[spec] = [`./${pkg.dir}/${target.replace(/^\.\//, "")}`];
    }
  }
  return Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
}

/** True for a file the payload drops (type declarations, source maps). */
export function isPrunable(name) {
  return PRUNE_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * True when `name` is a platform build of a native package (`@napi-rs/keyring-linux-x64-musl`,
 * `@anthropic-ai/claude-agent-sdk-win32-x64`) for another OS, CPU or libc than the target. pnpm
 * installs every libc variant on Linux; the musl one alone is 280 MB for the Agent SDK.
 */
export function isForeignPlatformPackage(name, platform, arch) {
  const m = PLATFORM_PACKAGE_RE.exec(name);
  if (!m) return false;
  const [, os, cpu, libc] = m;
  if (os !== platform || cpu !== arch) return true;
  return libc !== undefined && LIBC[platform] !== undefined && libc !== LIBC[platform];
}

/** The workspace packages `root` imports, transitively (by `workspace:` dependencies). */
export function workspaceClosure(rootName, byName) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`build-runtime-payload: no workspace package ${name}`);
    seen.add(name);
    for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
      if (String(spec).startsWith("workspace:")) visit(dep);
    }
  };
  visit(rootName);
  return [...seen].sort();
}

export function nodeBinaryName(platform) {
  return platform === "win32" ? "node.exe" : "node";
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--node") opts.node = argv[++i];
    else throw new Error(`build-runtime-payload: unknown argument ${a}`);
  }
  return opts;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function workspacePackages(repo) {
  const byName = new Map();
  for (const entry of readdirSync(path.join(repo, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(repo, "packages", entry.name, "package.json");
    if (!existsSync(file)) continue;
    const pkg = readJson(file);
    byName.set(pkg.name, { ...pkg, dir: `packages/${entry.name}` });
  }
  return byName;
}

/** pnpm with argv only: through the pnpm that runs this script when there is one. */
function runPnpm(args, cwd) {
  const execPath = process.env.npm_execpath;
  const viaNode = execPath && /\.(c?js|mjs)$/.test(execPath);
  const r = viaNode
    ? spawnSync(process.execPath, [execPath, ...args], { cwd, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
        cwd,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
  if (r.status !== 0) {
    throw new Error(
      `build-runtime-payload: pnpm ${args.join(" ")} failed (${r.status ?? r.error})`,
    );
  }
}

/** Rename, or copy and remove when the two sit on different file systems (a temp dir). */
function moveDir(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function walk(dir, onEntry) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (onEntry(full, entry) === false) continue;
    if (entry.isDirectory()) walk(full, onEntry);
  }
}

function pruneNodeModules(nm, platform, arch) {
  for (const entry of readdirSync(nm, { withFileTypes: true })) {
    if (entry.name.startsWith("."))
      rmSync(path.join(nm, entry.name), { recursive: true, force: true });
  }
  rmSync(path.join(nm, "@forerunner"), { recursive: true, force: true });
  const scopes = readdirSync(nm, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const scope of scopes) {
    const names = scope.name.startsWith("@")
      ? readdirSync(path.join(nm, scope.name)).map((n) => [
          path.join(nm, scope.name, n),
          `${scope.name}/${n}`,
        ])
      : [[path.join(nm, scope.name), scope.name]];
    for (const [dir, name] of names) {
      if (isForeignPlatformPackage(name, platform, arch))
        rmSync(dir, { recursive: true, force: true });
    }
  }
  walk(nm, (full, entry) => {
    if (entry.isSymbolicLink()) {
      rmSync(full, { force: true });
      return false;
    }
    if (entry.isFile() && isPrunable(entry.name)) {
      rmSync(full, { force: true });
      return false;
    }
    return true;
  });
}

function stats(dir) {
  let files = 0;
  let bytes = 0;
  walk(dir, (full, entry) => {
    if (entry.isFile()) {
      files++;
      bytes += statSync(full).size;
    }
    return true;
  });
  return { files, bytes };
}

export function build(opts = {}) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const out = path.resolve(opts.out ?? path.join(repo, ...DEFAULT_OUT));
  const platform = process.platform;
  const arch = process.arch;
  const rootPkg = readJson(path.join(repo, "package.json"));
  const byName = workspacePackages(repo);
  const closure = workspaceClosure("@forerunner/runtime", byName);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Third-party production dependencies, hoisted (real directories, no .pnpm store links).
  // Deployed outside the workspace: a target inside it makes pnpm also link a stray
  // `packages/runtime/<target>/node_modules/.bin` into the package being deployed.
  const deployDir = mkdtempSync(path.join(tmpdir(), "fr-runtime-deploy-"));
  try {
    runPnpm(
      [
        "--filter",
        "@forerunner/runtime",
        "deploy",
        "--prod",
        "--legacy",
        "--config.node-linker=hoisted",
        deployDir,
      ],
      repo,
    );
    moveDir(path.join(deployDir, "node_modules"), path.join(out, "node_modules"));
  } finally {
    rmSync(deployDir, { recursive: true, force: true });
  }
  pruneNodeModules(path.join(out, "node_modules"), platform, arch);
  if (!existsSync(path.join(out, "node_modules", "tsx", "dist", "cli.mjs"))) {
    throw new Error("build-runtime-payload: tsx is missing from the runtime's dependencies");
  }

  // Workspace sources, laid out as in the repository.
  const shipped = closure.map((name) => byName.get(name));
  for (const pkg of shipped) {
    const src = path.join(repo, ...pkg.dir.split("/"));
    const dest = path.join(out, ...pkg.dir.split("/"));
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      if (PACKAGE_SKIP.has(entry)) continue;
      cpSync(path.join(src, entry), path.join(dest, entry), { recursive: true });
    }
  }
  cpSync(path.join(repo, "evals", "registry"), path.join(out, "evals", "registry"), {
    recursive: true,
  });
  writeFileSync(
    path.join(out, "package.json"),
    `${JSON.stringify({ name: rootPkg.name, version: rootPkg.version, private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(out, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { paths: workspacePaths(shipped) } }, null, 2)}\n`,
  );

  // The Node.js binary.
  const nodeSrc = opts.node ?? process.execPath;
  const nodeDest = path.join(out, "node", nodeBinaryName(platform));
  mkdirSync(path.dirname(nodeDest), { recursive: true });
  cpSync(nodeSrc, nodeDest);
  chmodSync(nodeDest, 0o755);
  const nodeVersion = spawnSync(nodeDest, ["--version"], { encoding: "utf8" }).stdout.trim();
  if (!/^v\d+\./.test(nodeVersion)) {
    throw new Error(
      `build-runtime-payload: ${nodeSrc} does not run (${nodeVersion || "no output"})`,
    );
  }

  const manifest = {
    schema: 1,
    version: rootPkg.version,
    platform,
    arch,
    node: nodeVersion,
    entry: RUNTIME_ENTRY,
  };
  writeFileSync(path.join(out, "runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, manifest, packages: closure, ...stats(out) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const r = build(parseArgs(process.argv.slice(2)));
    console.log(
      `runtime payload ${r.manifest.version} (${r.manifest.platform}-${r.manifest.arch}, node ${r.manifest.node}) in ${r.out}: ${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MiB; packages ${r.packages.join(", ")}`,
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
