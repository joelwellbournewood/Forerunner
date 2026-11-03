import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { projectFileList, untestedFiles } from "../src/loop/project-checks.ts";
import { pagesToTry } from "../src/loop/try-it.ts";

/**
 * merged-copy (ADR 0113): the person's Local only folder is never evidence. The run's copy is
 * gone from the worktree before the review, and what reads the folder for the review skips it
 * anyway: the critic's file list (`projectFileList`), the project's test files no check ran
 * (`untestedFiles`) and the pages a change asks to be tried (`pagesToTry`).
 */
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "fr-local-only-evidence-"));
  roots.push(root);
  mkdirSync(join(root, "Local only", "drafts"), { recursive: true });
  writeFileSync(join(root, "Local only", "notes.txt"), "mine\n");
  writeFileSync(join(root, "Local only", "drafts", "page.html"), "<h1>draft</h1>\n");
  writeFileSync(join(root, "Local only", "drafts", "old.test.js"), "test('x', () => {});\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "Local only.md"), "a doc named like it\n");
  writeFileSync(join(root, "index.html"), "<h1>page</h1>\n");
  return root;
}

describe("Local only is never evidence (merged-copy)", () => {
  it("the critic's file list and the untested files leave it out; a file named like it elsewhere stays", () => {
    const root = folder();
    expect(projectFileList(root)).toEqual(["docs/Local only.md", "index.html"]);
    expect(untestedFiles(root)).toBeNull();
  });

  it("no page of Local only is tried, even when the changed files name one", () => {
    const root = folder();
    expect(pagesToTry(["Local only/drafts/page.html"], root)).toEqual([]);
    expect(pagesToTry(["Local only/drafts/page.html", "index.html"], root)).toEqual(["index.html"]);
    expect(pagesToTry([".forerunner-try/sample-1.html"], root)).toEqual([]);
  });
});
