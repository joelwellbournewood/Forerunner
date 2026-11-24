#!/usr/bin/env node
// Docs stay true: a change that touches a module must touch that module's maintainer doc,
// unless the PR body (or the commit messages in range) says "docs: none needed: <reason>".
// Usage: node scripts/docs-check.mjs [--base <ref>] [--body-file <path>] [--files <path>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MODULE_DOCS = [
  [/^packages\/platform\//, ["docs/maintainers/platform-notes.md"]],
  [/^packages\/state\//, ["docs/maintainers/data-model.md", "docs/maintainers/migrations.md"]],
  [/^packages\/vault\//, ["docs/maintainers/security.md"]],
  [/^packages\/billing\//, ["docs/maintainers/billing.md"]],
  [
    /^packages\/runtime\//,
    [
      "docs/maintainers/runtime.md",
      "docs/maintainers/sandbox.md",
      "docs/maintainers/extensions.md",
      "docs/maintainers/updates.md",
      "docs/maintainers/notifications.md",
      "docs/maintainers/model-watch.md",
      "docs/maintainers/data.md",
      "docs/maintainers/adding-a-provider.md",
      "docs/maintainers/adding-a-specialist.md",
    ],
  ],
  [/^packages\/commands\//, ["docs/maintainers/runtime.md", "docs/maintainers/commands.md"]],
  [/^packages\/memory\//, ["docs/maintainers/memory.md", "docs/maintainers/migrations.md"]],
  [/^packages\/critic\//, ["docs/maintainers/critic.md"]],
  [
    /^packages\/voice\//,
    ["docs/maintainers/adding-a-voice-provider.md", "docs/maintainers/voice.md"],
  ],
  [
    /^packages\/capabilities\//,
    [
      "docs/maintainers/adding-a-connector.md",
      "docs/maintainers/security.md",
      "docs/maintainers/capabilities.md",
      "docs/maintainers/email.md",
      "docs/maintainers/browser.md",
      "docs/maintainers/desktop-control.md",
      "docs/maintainers/cloudflare.md",
    ],
  ],
  [
    /^services\/state-api\//,
    ["docs/maintainers/architecture.md", "docs/maintainers/state-service.md"],
  ],
  [
    /^services\/cloud-runner\//,
    ["docs/maintainers/cloud-runner.md", "docs/maintainers/release.md"],
  ],
  [/^apps\//, ["docs/maintainers/apps.md", "docs/maintainers/platform-notes.md"]],
  [/^testenv\//, ["docs/maintainers/testing.md"]],
  [/^evals\//, ["docs/maintainers/testing.md", "docs/maintainers/adding-a-specialist.md"]],
  [/^tests\/e2e\//, ["docs/maintainers/testing.md"]],
  [/^\.github\/workflows\//, ["docs/maintainers/release.md", "docs/maintainers/testing.md"]],
  [
    /^scripts\//,
    [
      "docs/maintainers/testing.md",
      "docs/maintainers/release.md",
      "docs/maintainers/troubleshooting.md",
    ],
  ],
];
const WAIVER = /docs:\s*none needed\s*:\s*\S.*/i;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function evaluate(changed, waiverText) {
  const waived = WAIVER.test(waiverText ?? "");
  const missing = [];
  const docsTouched = new Set(changed.filter((f) => f.startsWith("docs/")));
  for (const [re, docs] of MODULE_DOCS) {
    const moduleFiles = changed.filter((f) => re.test(f) && !/\.test\.ts$/.test(f));
    if (moduleFiles.length === 0) continue;
    if (!docs.some((d) => docsTouched.has(d))) {
      missing.push({
        module: re.source.replace(/\\\//g, "/").replace(/^\^|\/$/g, ""),
        docs,
        files: moduleFiles.slice(0, 5),
      });
    }
  }
  return { waived, missing, ok: waived || missing.length === 0 };
}

function changedFiles(base) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.split(/\r?\n/).filter(Boolean);
}

/** Whether `ref` names a commit in this checkout (git's own error stays out of the output). */
function hasRef(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function waiverText(base, bodyFile) {
  let text = "";
  if (bodyFile && existsSync(bodyFile)) text += readFileSync(bodyFile, "utf8");
  if (process.env.PR_BODY) text += `\n${process.env.PR_BODY}`;
  try {
    text += `\n${execFileSync("git", ["log", "--format=%B", `${base}..HEAD`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })}`;
  } catch {
    // no range available
  }
  return text;
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const base = arg("--base") || process.env.DOCS_CHECK_BASE || "origin/main";
  const filesArg = arg("--files");
  // l4-selftasks-carried (L4-selftasks-125's rest): without the base (a worktree, or a clone
  // without origin/main) the check printed git's own error and passed; it says now that nothing
  // was checked and what it needs.
  if (!filesArg && !hasRef(base)) {
    console.log(
      base === "origin/main"
        ? "docs-check: nothing was checked: origin/main is not in this checkout (a worktree, or a clone without that branch). Name the branch this work started from: pnpm docs:check --base <branch>, or set DOCS_CHECK_BASE."
        : `docs-check: nothing was checked: ${base} is not a branch or commit in this checkout. Name the branch this work started from: pnpm docs:check --base <branch>.`,
    );
    process.exit(0);
  }
  let changed;
  try {
    changed = filesArg
      ? readFileSync(filesArg, "utf8").split(/\r?\n/).filter(Boolean)
      : changedFiles(base);
  } catch (e) {
    console.log(`docs-check: cannot diff against ${base} (${e.message}); nothing to check.`);
    process.exit(0);
  }
  const res = evaluate(changed, waiverText(base, arg("--body-file")));
  if (res.ok) {
    console.log(
      res.waived
        ? "docs-check: waived by 'docs: none needed: <reason>'."
        : `docs-check: ok (${changed.length} ${changed.length === 1 ? "file" : "files"}).`,
    );
    process.exit(0);
  }
  console.error("docs-check: modules changed without their maintainer doc:");
  for (const m of res.missing) {
    console.error(
      `  ${m.module}: touch one of ${m.docs.join(", ")} (changed: ${m.files.join(", ")})`,
    );
  }
  console.error("Add the doc change, or write 'docs: none needed: <reason>' in the PR body.");
  process.exit(1);
}
