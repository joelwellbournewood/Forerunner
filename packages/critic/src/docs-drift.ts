import { toPosix } from "@forerunner/platform";

/**
 * Doc drift (spec P.14, checked by the critic at tier 2+): a change that touches a module must
 * touch that module's maintainer doc, unless the PR body says `docs: none needed: <reason>`.
 *
 * MODULE_DOCS is a copy of the table in `scripts/docs-check.mjs` (the CI check). The two must
 * stay identical; `test/docs-drift.test.ts` reads the script and fails when they differ, so a
 * module added to one is added to the other in the same PR.
 */
export const MODULE_DOCS: readonly (readonly [RegExp, readonly string[]])[] = [
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

/** The waiver line the CI check accepts in a PR body or commit message. */
export const DOCS_WAIVER = /docs:\s*none needed\s*:\s*\S.*/i;

export interface DocDrift {
  /** The module pattern, rendered like the script does ("packages/critic"). */
  module: string;
  /** Docs that would have satisfied the rule. */
  docs: string[];
  /** Up to five module files that changed. */
  files: string[];
}

export interface DocDriftResult {
  waived: boolean;
  missing: DocDrift[];
  ok: boolean;
}

/** Same semantics as `evaluate(changed, waiverText)` in scripts/docs-check.mjs. */
export function evaluateDocsCheck(changed: readonly string[], waiverText?: string): DocDriftResult {
  const files = changed.map((f) => toPosix(f).replace(/^\.\//, ""));
  const waived = DOCS_WAIVER.test(waiverText ?? "");
  const missing: DocDrift[] = [];
  const docsTouched = new Set(files.filter((f) => f.startsWith("docs/")));
  for (const [re, docs] of MODULE_DOCS) {
    const moduleFiles = files.filter((f) => re.test(f) && !/\.test\.ts$/.test(f));
    if (moduleFiles.length === 0) continue;
    if (!docs.some((d) => docsTouched.has(d))) {
      missing.push({
        module: re.source.replace(/\\\//g, "/").replace(/^\^|\/$/g, ""),
        docs: [...docs],
        files: moduleFiles.slice(0, 5),
      });
    }
  }
  return { waived, missing, ok: waived || missing.length === 0 };
}

/**
 * Drift for a review: the module files the change touched against the docs it touched. The
 * critic adds one medium finding per module in `missing` (see critic.ts).
 */
export function docDriftFor(
  moduleFilesTouched: readonly string[],
  docsTouched: readonly string[],
  waiverText?: string,
): DocDriftResult {
  return evaluateDocsCheck([...moduleFilesTouched, ...docsTouched], waiverText);
}
