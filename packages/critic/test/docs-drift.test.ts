import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { DOCS_WAIVER, docDriftFor, evaluateDocsCheck, MODULE_DOCS } from "../src/docs-drift.ts";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
  "docs-check.mjs",
);

/** The script's table, evaluated from its source text (it is not exported). */
function scriptTable(): [RegExp, string[]][] {
  const src = readFileSync(SCRIPT, "utf8");
  const m = /const MODULE_DOCS = (\[[\s\S]*?\n\]);/.exec(src);
  if (!m?.[1]) throw new Error("MODULE_DOCS not found in scripts/docs-check.mjs");
  return new Function(`return ${m[1]};`)() as [RegExp, string[]][];
}

describe("doc drift (P.14)", () => {
  it("keeps the same module-to-doc table as scripts/docs-check.mjs", () => {
    const theirs = scriptTable().map(([re, docs]) => [re.source, re.flags, [...docs]]);
    const ours = MODULE_DOCS.map(([re, docs]) => [re.source, re.flags, [...docs]]);
    expect(ours).toEqual(theirs);
    expect(ours.length).toBeGreaterThan(10);
  });

  it("evaluates exactly like the script on the same inputs", async () => {
    const mod = (await import(pathToFileURL(SCRIPT).href)) as {
      evaluate: (changed: string[], waiver?: string) => unknown;
    };
    const samples: [string[], string | undefined][] = [
      [["packages/critic/src/critic.ts"], undefined],
      [["packages/critic/src/critic.ts", "docs/maintainers/critic.md"], undefined],
      [["packages/critic/test/critic.test.ts"], undefined],
      [
        ["packages/runtime/src/x.ts", "docs/maintainers/sandbox.md", "apps/ui/src/a.tsx"],
        undefined,
      ],
      [["scripts/x.mjs"], "docs: none needed: script comment only"],
      [["services/state-api/src/a.ts", "evals/registry/x.json"], "docs: none needed:"],
    ];
    for (const [changed, waiver] of samples) {
      expect(evaluateDocsCheck(changed, waiver), changed.join(",")).toEqual(
        mod.evaluate(changed, waiver),
      );
    }
  });

  it("flags a module changed without its doc, ignores test files, and honours the waiver", () => {
    const drift = evaluateDocsCheck([
      "packages/critic/src/rules.ts",
      "packages/critic/src/model.ts",
    ]);
    expect(drift.ok).toBe(false);
    expect(drift.missing).toEqual([
      {
        module: "packages/critic",
        docs: ["docs/maintainers/critic.md"],
        files: ["packages/critic/src/rules.ts", "packages/critic/src/model.ts"],
      },
    ]);
    expect(
      evaluateDocsCheck(["packages/critic/src/rules.ts", "docs/maintainers/critic.md"]).ok,
    ).toBe(true);
    expect(evaluateDocsCheck(["packages/critic/test/rules.test.ts"]).missing).toEqual([]);
    const waived = evaluateDocsCheck(
      ["packages/critic/src/rules.ts"],
      "PR body\n\ndocs: none needed: comment-only change",
    );
    expect(waived).toMatchObject({ ok: true, waived: true });
    expect(waived.missing).toHaveLength(1);
    expect(DOCS_WAIVER.test("docs: none needed:")).toBe(false);
  });

  it("docDriftFor joins module files and docs touched, accepting Windows separators", () => {
    expect(
      docDriftFor(["packages\\memory\\src\\service.ts"], ["docs/maintainers/memory.md"]).ok,
    ).toBe(true);
    const r = docDriftFor(
      ["packages/memory/src/service.ts", "packages/vault/src/a.ts"],
      ["docs/maintainers/memory.md"],
    );
    expect(r.missing.map((m) => m.module)).toEqual(["packages/vault"]);
  });
});
