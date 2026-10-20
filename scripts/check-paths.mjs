#!/usr/bin/env node
// Lint for hand-built paths. AGENTS.md: paths go through @forerunner/platform/paths; nothing
// outside packages/platform concatenates with "/" or "\\" by hand or imports node:path.
//
// Rules (TS/TSX outside packages/platform; comments, regex literals and import lines are ignored):
//   concat-slash   a string containing "/" or "\\" is concatenated with "+" on a line that also
//                  names a path-like identifier (dir, file, root, cwd, worktree, ...), e.g.
//                  `dir + "/" + name`, `"logs/" + file`. URL-shaped lines (http, url, api, route,
//                  fetch, href, ://) are not reported.
//   node-path      the file imports "node:path" or "path" instead of @forerunner/platform.
// A line ending in `// path-ok` is skipped (say why in the comment); a file containing
// `check-paths-ignore-file` is skipped as a whole (only for the lint's own fixtures).
//
// Usage: node scripts/check-paths.mjs [--json] [paths...]   (default: packages services apps testenv evals tests scripts)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_ROOTS = [
  "packages",
  "services",
  "apps",
  "testenv",
  "evals",
  "tests",
  "scripts",
];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "gen", "coverage", ".git"]);
const PLATFORM_PREFIX = /^packages\/platform\//;

export const PATH_IDENT_RE =
  /\b(?:path|paths|dir|dirs|directory|dirname|file|filename|filepath|files|folder|root|rootdir|home|homedir|cwd|base|basedir|basepath|tmp|tmpdir|temp|tempdir|worktree|worktrees|workdir|workspace|repo|checkout|appdata|config|cache|logs|data|dest|destination|target|src|source|out|outdir|output)\w*\b/i;
const URL_LINE_RE =
  /\b(?:https?|wss?|ftp|url|href|api|endpoint|route|fetch|origin|host|mailto)\w*|:\/\//i;
// a string literal holding "/" or a literal backslash ("\\"), followed by "+"
const CONCAT_AFTER_RE = /["'`][^"'`\n]*(?:\/|\\\\)[^"'`\n]*["'`]\s*\+/;
// "+" followed by a string literal that starts with "/" or a literal backslash
const CONCAT_BEFORE_RE = /\+\s*["'`](?:\/|\\\\)/;
const IMPORT_LINE_RE = /^\s*(?:import\b|export\b.*\bfrom\b|.*\brequire\s*\(|.*\bimport\s*\()/;
const NODE_PATH_IMPORT_RE =
  /\b(?:from|import|require\s*\()\s*["'](?:node:)?path(?:\/posix|\/win32)?["']/;
const REGEX_PRECEDER_RE =
  /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bdo|\belse|\bin|\bof|\bnew|\bdelete|\bvoid|\bthrow|\byield|\bawait)\s*$/;

/**
 * Replace comments and regex literals with spaces while keeping strings, template literals
 * and line breaks, so line numbers are preserved and string contents stay inspectable.
 */
export function stripComments(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  // state stack entries: "code" | "template"; `templateDepth` tracks ${ } nesting
  const stack = ["code"];
  const braceDepth = [0];
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    const mode = stack[stack.length - 1];
    if (mode === "template") {
      if (c === "\\") {
        out.push(c, next ?? "");
        i += 2;
        continue;
      }
      if (c === "`") {
        out.push(c);
        stack.pop();
        braceDepth.pop();
        i++;
        continue;
      }
      if (c === "$" && next === "{") {
        out.push("${");
        stack.push("code");
        braceDepth.push(0);
        i += 2;
        continue;
      }
      out.push(c);
      i++;
      continue;
    }
    // code mode
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      out.push("  ");
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out.push(c);
      i++;
      while (i < n && src[i] !== quote && src[i] !== "\n") {
        if (src[i] === "\\") {
          out.push(src[i], src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out.push(src[i]);
        i++;
      }
      out.push(src[i] ?? "");
      i++;
      continue;
    }
    if (c === "`") {
      out.push(c);
      stack.push("template");
      braceDepth.push(0);
      i++;
      continue;
    }
    if (c === "{") {
      braceDepth[braceDepth.length - 1]++;
      out.push(c);
      i++;
      continue;
    }
    if (c === "}") {
      if (braceDepth[braceDepth.length - 1] === 0 && stack.length > 1) {
        // closes a ${ } inside a template literal
        stack.pop();
        braceDepth.pop();
        out.push(c);
        i++;
        continue;
      }
      braceDepth[braceDepth.length - 1]--;
      out.push(c);
      i++;
      continue;
    }
    if (c === "/") {
      // regex literal when the previous significant token cannot end an expression
      const before = out.join("").split("\n").pop() ?? "";
      if (REGEX_PRECEDER_RE.test(before)) {
        out.push("/");
        i++;
        let inClass = false;
        while (i < n && src[i] !== "\n") {
          const ch = src[i];
          if (ch === "\\") {
            out.push("  ");
            i += 2;
            continue;
          }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
          out.push(" ");
          i++;
        }
        out.push(src[i] === "/" ? "/" : "");
        if (src[i] === "/") i++;
        while (i < n && /[a-z]/i.test(src[i] ?? "")) {
          out.push(" ");
          i++;
        }
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/** Lint one source text. Returns findings { file, line, rule, text }. */
export function lintSource(text, file) {
  const findings = [];
  const posixFile = file.split(path.sep).join("/").replace(/\\/g, "/");
  if (PLATFORM_PREFIX.test(posixFile) || posixFile.includes("/packages/platform/")) return findings;
  if (/check-paths-ignore-file/.test(text)) return findings;
  const originalLines = text.split(/\r?\n/);
  const codeLines = stripComments(text.replace(/\r\n?/g, "\n")).split("\n");
  for (let i = 0; i < codeLines.length; i++) {
    const original = originalLines[i] ?? "";
    const code = codeLines[i] ?? "";
    if (/\/\/\s*path-ok\b/.test(original)) continue;
    if (NODE_PATH_IMPORT_RE.test(code)) {
      findings.push({
        file: posixFile,
        line: i + 1,
        rule: "node-path",
        text: original.trim(),
        hint: 'import { join, resolve, ... } from "@forerunner/platform/paths"',
      });
      continue;
    }
    if (IMPORT_LINE_RE.test(code)) continue;
    if (!(CONCAT_AFTER_RE.test(code) || CONCAT_BEFORE_RE.test(code))) continue;
    if (!PATH_IDENT_RE.test(code)) continue;
    if (URL_LINE_RE.test(code)) continue;
    findings.push({
      file: posixFile,
      line: i + 1,
      rule: "concat-slash",
      text: original.trim(),
      hint: "use join(...) from @forerunner/platform/paths (or add `// path-ok <why>` when it is not a file path)",
    });
  }
  return findings;
}

function walk(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

export function collectFiles(roots) {
  const files = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (statSync(root).isDirectory()) walk(root, files);
    else if (/\.tsx?$/.test(root)) files.push(root);
  }
  return files;
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const roots = args.filter((a) => !a.startsWith("--"));
  const files = collectFiles(roots.length ? roots : DEFAULT_ROOTS);
  const findings = [];
  for (const f of files)
    findings.push(...lintSource(readFileSync(f, "utf8"), path.relative(".", f)));
  if (json) {
    console.log(JSON.stringify({ files: files.length, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`check-paths: ok (${files.length} files).`);
  } else {
    console.error(`check-paths: ${findings.length} hand-built path(s) in ${files.length} files:`);
    for (const f of findings)
      console.error(`  ${f.file}:${f.line} [${f.rule}] ${f.text}\n      ${f.hint}`);
  }
  process.exit(findings.length ? 1 : 0);
}
