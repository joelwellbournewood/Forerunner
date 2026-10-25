#!/usr/bin/env node
// Scans tracked files (and, with --logs, log directories) for credential shapes.
// Exit 1 on any hit. Allowlist obvious fixtures with a trailing comment `// not-a-secret`
// or by listing the path in .secretscanignore.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PATTERNS = [
  ["anthropic", /sk-ant-(?:api|oat|admin)\d{2}-[A-Za-z0-9_-]{20,}/g],
  ["github", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g],
  ["gitlab", /\bglpat-[A-Za-z0-9_-]{20}\b/g],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["aws", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ["cloudflare", /\b[A-Za-z0-9_-]{40}\b(?=.*cloudflare)/gi],
  ["deepgram", /\bdg_[A-Za-z0-9]{32,}\b/g],
  // Google API keys: what a committed google-services.json (FCM, ADR 0085) would leak.
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  [
    "generic-assignment",
    /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9+/_=-]{24,}["']/gi,
  ],
];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", "coverage", "gen"]);
const BINARY = /\.(png|jpg|jpeg|gif|ico|icns|woff2?|ttf|pdf|zip|gz|jar|apk|keystore|wav|mp3)$/i;

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
function ignoreList() {
  if (!existsSync(".secretscanignore")) return [];
  return readFileSync(".secretscanignore", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"));
}

export function scanText(text, file) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/not-a-secret/.test(line)) return;
    for (const [name, re] of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line))
        hits.push({
          file,
          line: i + 1,
          kind: name,
          preview: line.slice(0, 60).replace(/[A-Za-z0-9]{8,}/g, (m) => `${m.slice(0, 4)}…`),
        });
    }
  });
  return hits;
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const args = process.argv.slice(2);
  const scanLogs = args.includes("--logs");
  const extra = args.filter((a) => !a.startsWith("--"));
  const ignores = ignoreList();
  let files = [];
  if (!scanLogs && extra.length === 0) files = trackedFiles();
  for (const p of extra) files.push(...(statSync(p).isDirectory() ? walk(p) : [p]));
  if (scanLogs) {
    for (const d of ["logs", ".forerunner-dev", process.env.FORERUNNER_HOME].filter(Boolean)) {
      if (existsSync(d)) files.push(...walk(d));
    }
  }
  const hits = [];
  for (const f of files) {
    if (BINARY.test(f) || ignores.some((ig) => relative(".", f).startsWith(ig))) continue;
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (text.length > 5_000_000) continue;
    hits.push(...scanText(text, f));
  }
  if (hits.length === 0) {
    console.log(`secret-scan: clean (${files.length} files).`);
    process.exit(0);
  }
  console.error(`secret-scan: ${hits.length} possible secret(s):`);
  for (const h of hits) console.error(`  ${h.file}:${h.line} [${h.kind}] ${h.preview}`);
  process.exit(1);
}
