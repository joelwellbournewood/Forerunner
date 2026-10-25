import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { evaluate } from "./docs-check.mjs";

/**
 * Requirements close-out for the maintainer documentation (spec P.1 to P.3, P.5 to P.14):
 * the docs the spec names exist, carry the sections a maintainer needs (Purpose, How it
 * works, How to change it, Tests, Known issues), are not skeletons, and say what their
 * requirement clause asks for; the ADRs follow the template and are indexed; the changelog
 * has its Unreleased section; and the "docs stay true" machinery runs: the module-to-doc
 * mapping covers every module and names docs that exist, and the link checker fails on a
 * broken relative link and passes on a good one (CI runs it on every PR).
 *
 * The four `adding-a-*` guides (P.7) get the same filled-sections assertion; the connector
 * guide must also name the catalog entry, the ToolSpec mapping of ADR 0016, the permissions
 * and the tests. `security.md` (P.11) must describe the injection test suite (where the cases
 * live, how a vector is added, how the gate reads the result) and carry no "to be filled"
 * placeholder.
 */
const repoRoot = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");
const maintainers = (name: string) => read("docs", "maintainers", name);

const STANDARD_SECTIONS = ["Purpose", "How it works", "How to change it", "Tests", "Known issues"];

/** `## ` sections of a Markdown file: heading -> body text (sub-headings included). */
function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  const body: string[] = [];
  const flush = () => {
    if (current !== null) out.set(current, body.join("\n").trim());
    body.length = 0;
  };
  for (const line of md.split(/\r?\n/)) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1] ?? null;
    } else body.push(line);
  }
  flush();
  return out;
}

function expectFilledSections(name: string, md: string, names = STANDARD_SECTIONS) {
  expect(md, name).not.toMatch(/Status: skeleton/);
  const got = sections(md);
  for (const s of names) {
    expect([...got.keys()], `${name}: section "${s}"`).toContain(s);
    expect((got.get(s) ?? "").length, `${name}: section "${s}" has a body`).toBeGreaterThan(60);
  }
}

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("P.1 AGENTS.md and CLAUDE.md", () => {
  it("CLAUDE.md points to AGENTS.md, which carries the commands for both OSes, the layout, the conventions and the build-prompt rules", () => {
    const claude = read("CLAUDE.md");
    expect(claude).toMatch(/Read `AGENTS\.md` first/);
    const agents = read("AGENTS.md");
    const got = sections(agents);
    const headings = [...got.keys()];
    expect(headings).toContain("Commands (identical on Windows and Linux)");
    expect(headings).toContain("Repository layout");
    expect(headings).toContain("Conventions");
    expect(headings).toContain("Definition of done (per change)");
    expect(headings).toContain("Rules from the build prompt (always in force)");
    const commands = got.get("Commands (identical on Windows and Linux)") ?? "";
    for (const cmd of [
      "pnpm install",
      "pnpm check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm test:integration",
      "pnpm test:e2e",
      "pnpm docs:check",
      "pnpm secrets:scan",
      "pnpm state-api",
      "pnpm fr --",
      "tauri dev",
    ])
      expect(commands, `command ${cmd}`).toContain(cmd);
    expect(commands).toMatch(/dev-postgres\.sh.*\.ps1/);
    const layout = got.get("Repository layout") ?? "";
    for (const dir of [
      "apps/desktop/",
      "apps/mobile/",
      "apps/approvals-web/",
      "packages/platform/",
      "packages/state/",
      "packages/vault/",
      "packages/billing/",
      "packages/runtime/",
      "packages/commands/",
      "packages/memory/",
      "packages/critic/",
      "packages/voice/",
      "packages/capabilities/",
      "services/state-api/",
      "services/cloud-runner/",
      "testenv/",
      "evals/",
      "tests/e2e/",
      "docs/maintainers",
      "docs/decisions",
      "docs/status",
      "scripts/",
    ]) {
      expect(layout, `layout names ${dir}`).toContain(dir);
      expect(existsSync(join(repoRoot, dir)), `${dir} exists`).toBe(true);
    }
    const conventions = got.get("Conventions") ?? "";
    for (const rule of ["@forerunner/platform/paths", "Clock", "ISO-8601 UTC", "ForerunnerError"])
      expect(conventions).toContain(rule);
    const rules = got.get("Rules from the build prompt (always in force)") ?? "";
    expect(rules).toMatch(/Nothing hardcoded/);
    expect(rules).toMatch(/Enforce limits in code/);
    expect(rules).toMatch(/record an ADR/);
    expect(rules).toMatch(/Never idle/);
    expect(rules).toMatch(/Never mark a check passed without evidence/);
  });
});

describe("P.2, P.3, P.5, P.6, P.8 to P.12: one filled file per area, saying what its clause asks", () => {
  const docs: [string, (RegExp | string)[], string[]?][] = [
    // P.3: components, data flow, the diagram source (its own section set: no module to change)
    [
      "architecture.md",
      ["## Components", "## Data flow of one session", "## Diagram source", "```mermaid"],
      [
        "Purpose",
        "Components",
        "Data flow of one session",
        "How to change it",
        "Tests",
        "Diagram source",
      ],
    ],
    // P.5: hooks, budget, depth, autonomy and permission enforcement
    [
      "runtime.md",
      [
        "### Enforcement hooks",
        "### Autonomy",
        "### Kill switch",
        /budget/i,
        /depth and max depth/i,
        /permission_change/,
      ],
    ],
    // P.6: billing sources and routing, and what to change when provider rules change
    ["billing.md", [/billing source/i, /routing/i, "**Provider rule change**"]],
    // P.8: Windows and Linux differences and known issues
    ["platform-notes.md", ["| Concern | Windows | Linux |", "## Known issues"]],
    // P.9: signing, staged rollout, rollback
    ["release.md", ["### Signing", /staged/i, /rollback/i]],
    // P.10: schema and memory-format migrations
    ["migrations.md", [/schema migration/i, "### Memory-format migrations"]],
    // P.11: threat model and the injection test suite (its own assertion below)
    ["security.md", ["### Threat model", "### Injection test suite"]],
    // P.12: common failures and fixes
    ["troubleshooting.md", [/### 1\. /, /### 5\. /, /\*\*Fix/]],
  ];
  for (const [name, phrases, own] of docs) {
    it(`${name} is filled and covers its clause`, () => {
      const md = maintainers(name);
      expectFilledSections(name, md, own ?? STANDARD_SECTIONS);
      for (const p of phrases) {
        if (typeof p === "string") expect(md, `${name}: ${p}`).toContain(p);
        else expect(md, `${name}: ${p}`).toMatch(p);
      }
    });
  }

  it("troubleshooting.md pairs every numbered failure with a fix", () => {
    const md = maintainers("troubleshooting.md");
    const failures = md.match(/^### \d+\. /gm) ?? [];
    expect(failures.length).toBeGreaterThanOrEqual(5);
    const fixes = md.match(/\*\*Fix[^*]*\*\*/g) ?? [];
    expect(fixes.length).toBeGreaterThanOrEqual(failures.length);
  });

  it("security.md describes the injection test suite (cases, adding a vector, how the gate reads the result) and carries no placeholder", () => {
    const md = maintainers("security.md");
    expect(md).not.toMatch(/to be filled/i);
    const suite = md.slice(md.indexOf("### Injection test suite"));
    expect(suite.length, "the section exists").toBeGreaterThan(60);
    for (const p of [
      // where the cases and the harness live
      "evals/injection/cases/",
      "evals/src/injection-runner.ts",
      "evals/test/injection.test.ts",
      "packages/runtime/src/injection/scan.ts",
      "tests/e2e/scenarios/06-injection.scenario.test.ts",
      // how a new vector is added
      "HOSTILE_TECHNIQUES",
      "enforcement_only",
      // how the gate reads the result
      "pnpm test:injection",
      "injection-report.json",
      ".github/workflows/ci.yml",
    ])
      expect(suite, `security.md injection suite: ${p}`).toContain(p);
    expect(suite).toMatch(/exit code/i);
  });

  it("the maintainers README indexes every file in the directory", () => {
    const readme = maintainers("README.md");
    const files = readdirSync(join(repoRoot, "docs", "maintainers")).filter(
      (f) => f.endsWith(".md") && f !== "README.md",
    );
    for (const f of files) expect(readme, `README lists ${f}`).toContain(f);
  });
});

describe("P.7 the adding-a-* guides", () => {
  for (const name of [
    "adding-a-specialist.md",
    "adding-a-provider.md",
    "adding-a-voice-provider.md",
    "adding-a-connector.md",
  ]) {
    it(`${name} is filled and walks through numbered steps`, () => {
      const md = maintainers(name);
      expectFilledSections(name, md);
      expect(sections(md).get("How to change it") ?? "").toMatch(/^\s*1\. /m);
    });
  }

  it("adding-a-connector.md names the catalog entry, the ToolSpec mapping of ADR 0016, the permissions and the tests", () => {
    const md = maintainers("adding-a-connector.md");
    for (const p of [
      // the catalog entry
      "packages/runtime/src/extensions/catalog.json",
      "CatalogEntry",
      // the ToolSpec mapping
      "ADR 0016",
      "BridgedToolSpec",
      "inferActionClass",
      // the permissions
      "ExtensionPermissions",
      "actionClasses",
      "grantedToolNames",
      // live revocation and the tests
      "revokeLive",
      "extensions-catalog.test.ts",
      "extensions-mcp.test.ts",
      "extensions-registry.test.ts",
      "extensions-gate.test.ts",
    ])
      expect(md, `adding-a-connector.md: ${p}`).toContain(p);
  });
});

describe("P.13 ADRs and the changelog", () => {
  it("every ADR follows the template (number, title, date, status, context, decision, consequences) and is indexed in the README", () => {
    const dir = join(repoRoot, "docs", "decisions");
    const files = readdirSync(dir).filter((f) => /^\d{4}-.+\.md$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(40);
    const readme = read("docs", "decisions", "README.md");
    expect(readme).toContain("## Context");
    expect(readme).toContain("## Decision");
    expect(readme).toContain("## Consequences");
    const numbers = new Set<string>();
    for (const f of files) {
      const number = f.slice(0, 4);
      expect(numbers.has(number), `ADR number ${number} is unique`).toBe(false);
      numbers.add(number);
      const md = readFileSync(join(dir, f), "utf8");
      expect(md, f).toMatch(new RegExp(`^# ${number} — .+`, "m"));
      expect(md, f).toMatch(/^Date: \d{4}-\d{2}-\d{2}/m);
      expect(md, f).toMatch(/^Status: (accepted|superseded by \d{4})/m);
      for (const s of ["## Context", "## Decision", "## Consequences"])
        expect(md, `${f}: ${s}`).toContain(s);
      expect(readme, `README indexes ADR ${number}`).toMatch(
        new RegExp(`^\\| ${number} \\| `, "m"),
      );
    }
  });

  it("the changelog keeps an Unreleased section in Keep a Changelog form, and the release notes script reads it", () => {
    const changelog = read("CHANGELOG.md");
    expect(changelog).toContain("## [Unreleased]");
    expect(changelog).toContain("keepachangelog.com");
    expect(changelog).toMatch(/scripts\/release-notes\.mjs <tag>/);
    expect(existsSync(join(repoRoot, "scripts", "release-notes.mjs"))).toBe(true);
  });
});

describe("P.14 docs stay true", () => {
  it("the module-to-doc mapping covers every module directory and names docs that exist", () => {
    const moduleFiles = [
      ...readdirSync(join(repoRoot, "packages")).map((p) => `packages/${p}/src/index.ts`),
      ...readdirSync(join(repoRoot, "services")).map((s) => `services/${s}/src/index.ts`),
      "apps/ui/src/App.tsx",
      "apps/desktop/src-tauri/src/main.rs",
      "apps/mobile/src-tauri/src/lib.rs",
      "apps/approvals-web/src/main.tsx",
      "testenv/src/index.ts",
      "evals/src/index.ts",
      "tests/e2e/src/world.ts",
      ".github/workflows/ci.yml",
      "scripts/link-check.mjs",
    ];
    for (const file of moduleFiles) {
      const r = evaluate([file], "") as { ok: boolean; missing: { docs: string[] }[] };
      expect(r.ok, `${file} needs its doc`).toBe(false);
      expect(r.missing.length, `${file} maps to a module`).toBeGreaterThan(0);
      for (const doc of r.missing.flatMap((m) => m.docs))
        expect(existsSync(join(repoRoot, doc)), `${doc} exists (for ${file})`).toBe(true);
      // Touching one of the named docs satisfies the check; a waiver without a reason does not.
      const doc = r.missing[0]?.docs[0] ?? "";
      expect((evaluate([file, doc], "") as { ok: boolean }).ok).toBe(true);
      expect((evaluate([file], "docs: none needed") as { ok: boolean }).ok).toBe(false);
    }
  });

  it("the link checker fails on a broken relative link and passes on a good one", () => {
    const script = join(repoRoot, "scripts", "link-check.mjs");
    const run = (dir: string) =>
      spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });

    const broken = mkdtempSync(join(tmpdir(), "fr-links-broken-"));
    temps.push(broken);
    mkdirSync(join(broken, "docs"));
    writeFileSync(join(broken, "docs", "a.md"), "# A\n\nSee [the guide](./missing.md).\n");
    const bad = run(broken);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("missing ./missing.md");
    expect(bad.stderr).toContain("1 broken link(s)");

    const good = mkdtempSync(join(tmpdir(), "fr-links-good-"));
    temps.push(good);
    mkdirSync(join(good, "docs"));
    writeFileSync(
      join(good, "docs", "a.md"),
      "# A\n\nSee [B](./b.md#part) and [web](https://example.invalid/x).\n",
    );
    writeFileSync(join(good, "docs", "b.md"), "# B\n");
    const ok = run(good);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("link-check: ok (2 files)");
  });

  it("CI runs the docs check, the link checker and the schema-doc currency check on every PR", () => {
    const ci = read(".github", "workflows", "ci.yml");
    expect(ci).toMatch(/pnpm docs:check --base/);
    expect(ci).toContain("pnpm docs:links");
    expect(ci).toContain("pnpm docs:schema");
    expect(ci).toMatch(/git diff --exit-code -- docs\/maintainers\/data-model\.md/);
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["docs:links"]).toBe("node scripts/link-check.mjs");
    expect(pkg.scripts["docs:check"]).toBe("node scripts/docs-check.mjs");
    expect(pkg.scripts.check).toContain("pnpm docs:check && pnpm docs:links");
  });
});
