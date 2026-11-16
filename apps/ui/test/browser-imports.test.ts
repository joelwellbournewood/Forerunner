/**
 * d1109-run-visible (found on the bench walk): the app the person opens is the browser build,
 * and a value import from the runtime package that reaches a Node module ("node:crypto" through
 * task-words.ts) makes Vite externalize it and the whole page throws at load ("Module
 * "node:crypto" has been externalized for browser compatibility"): a blank window. The unit
 * suite runs in Node, so it never saw it. This walks every value import the UI makes into the
 * workspace's packages, through their own relative imports, and fails on any Node built-in it
 * reaches, naming the chain.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const UI_SRC = path.join(ROOT, "apps", "ui", "src");
const BUILTINS = new Set(builtinModules);

function filesOf(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesOf(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The specifiers a file imports for its values (no `import type`, no dynamic import). */
function valueImports(file: string): string[] {
  const src = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  const re = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) if (!m[2]) out.push(m[3] as string);
  return out;
}

function resolveFile(base: string): string | null {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** A workspace package's file (`@forerunner/x` → src/index.ts, `@forerunner/x/y` → src/y.ts). */
function resolvePackage(spec: string): string | null {
  const m = /^@forerunner\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (!m) return null;
  const dir = path.join(ROOT, "packages", m[1] as string, "src");
  return resolveFile(m[2] ? path.join(dir, m[2]) : path.join(dir, "index"));
}

/** The first chain from `file` to a Node built-in, or null. */
function nodeChain(file: string, seen: Set<string>, trail: string[]): string[] | null {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const spec of valueImports(file)) {
    const bare = spec.replace(/^node:/, "");
    if (spec.startsWith("node:") || BUILTINS.has(bare.split("/")[0] as string))
      return [...trail, path.relative(ROOT, file), spec];
    const next = spec.startsWith(".")
      ? resolveFile(path.resolve(path.dirname(file), spec))
      : resolvePackage(spec);
    if (!next) continue;
    const chain = nodeChain(next, seen, [...trail, path.relative(ROOT, file)]);
    if (chain) return chain;
  }
  return null;
}

describe("the browser build reaches no Node module (d1109-run-visible)", () => {
  it("every value import of a workspace package from apps/ui/src stays browser-safe", () => {
    const found: string[] = [];
    for (const file of filesOf(UI_SRC)) {
      for (const spec of valueImports(file)) {
        if (!spec.startsWith("@forerunner/")) continue;
        const target = resolvePackage(spec);
        if (!target) continue;
        const chain = nodeChain(target, new Set(), [`${path.relative(ROOT, file)} (${spec})`]);
        if (chain) found.push(chain.join(" -> "));
      }
    }
    expect(found).toEqual([]);
  });

  it("the walk finds a Node module where there is one (the check itself)", () => {
    const chain = nodeChain(
      path.join(ROOT, "packages", "runtime", "src", "daemon", "task-words.ts"),
      new Set(),
      [],
    );
    expect(chain?.at(-1)).toMatch(/^(node:)?[a-z_]+/);
  });
});
