#!/usr/bin/env node
// Checks relative links in Markdown under docs/, AGENTS.md, CLAUDE.md, README.md.
// External links are listed but not fetched (network policy differs per machine).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function mdFiles(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules") mdFiles(p, acc);
    } else if (p.endsWith(".md")) acc.push(p);
  }
  return acc;
}
const files = [
  ...(existsSync("docs") ? mdFiles("docs") : []),
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
].filter(existsSync);
const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let broken = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(linkRe)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [pathPart] = target.split("#");
    const abs = resolve(dirname(f), pathPart);
    if (!existsSync(abs)) {
      broken++;
      console.error(`link-check: ${f}: missing ${target}`);
    }
  }
}
if (broken) {
  console.error(`link-check: ${broken} broken link(s).`);
  process.exit(1);
}
console.log(`link-check: ok (${files.length} files).`);
