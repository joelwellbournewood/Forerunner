import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, fromPosix, join } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chunkMarkdown,
  collectDocFiles,
  DOCS_BLOCK_HEADER,
  loadDocChunks,
  renderDocHits,
  searchDocs,
  selectDocHits,
} from "../src/docs-search.ts";
import { estimateTokens } from "../src/types.ts";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "fr-memory-docs-search-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function put(rel: string, text: string): Promise<void> {
  const abs = join(repo, fromPosix(rel));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text, "utf8");
}

const RUNBOOK = `---
maintained-by: forerunner
read_if: "Something is broken"
---
# Runbook

## Start and stop

Run the service with the start script.

## Deploy

Deploys go out through the blue-green switch on the staging cluster. Roll back by flipping the
switch back; the old pods stay warm for thirty minutes.
`;

describe("project docs search (spec J.1)", () => {
  it("collects README.md and the markdown under docs/, skipping other trees and symlinks", async () => {
    await put("README.md", "# Game\n");
    await put("docs/runbook.md", RUNBOOK);
    await put("docs/decisions/0001-engine.md", "# 0001 Engine\n\nWe use Godot.\n");
    await put("src/notes.md", "# Not a doc\n");
    await put("docs/image.png", "png");
    await put("node_modules/x/README.md", "# dep\n");
    const outside = await mkdtemp(join(tmpdir(), "fr-memory-docs-outside-"));
    try {
      await writeFile(join(outside, "secret.md"), "# Outside\n\nnot this\n", "utf8");
      await symlink(join(outside, "secret.md"), join(repo, "docs", "link.md"));
    } catch {
      // A platform without symlink rights (Windows without developer mode): nothing to check.
    }
    const files = await collectDocFiles(repo);
    expect(files.map((f) => f.path)).toEqual([
      "README.md",
      "docs/decisions/0001-engine.md",
      "docs/runbook.md",
    ]);
    await rm(outside, { recursive: true, force: true });
  });

  it("chunks by heading with the heading trail, frontmatter and empty sections dropped", () => {
    const chunks = chunkMarkdown("docs/runbook.md", RUNBOOK);
    expect(chunks.map((c) => c.heading)).toEqual(["Runbook > Start and stop", "Runbook > Deploy"]);
    expect(chunks.every((c) => !c.text.includes("maintained-by"))).toBe(true);
    expect(chunks[1]?.text).toContain("blue-green switch");
  });

  it("splits an overlong section so no chunk is larger than the chunk size", () => {
    const para = (i: number) => `Paragraph ${i} ${"word ".repeat(60)}`;
    const text = `# Big\n\n${Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n")}\n`;
    const chunks = chunkMarkdown("docs/big.md", text, { chunkTokens: 120 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(estimateTokens(c.text)).toBeLessThanOrEqual(120);
  });

  it("ranks the section that answers the question first and cites its path", async () => {
    await put("README.md", "# Game\n\nA small platformer.\n");
    await put("docs/runbook.md", RUNBOOK);
    await put("docs/data.md", "# Data\n\n## Stores\n\nSaves live in SQLite.\n");
    const r = await searchDocs(repo, "how do we deploy and roll back?", { maxTokens: 400 });
    expect(r.hits[0]?.path).toBe("docs/runbook.md");
    expect(r.hits[0]?.heading).toBe("Runbook > Deploy");
    expect(r.block.startsWith(DOCS_BLOCK_HEADER)).toBe(true);
    expect(r.block).toContain("[docs/runbook.md > Runbook > Deploy]");
    expect(r.block).toContain("blue-green switch");
    // A chunk sharing no term with the question is not returned.
    expect(r.hits.some((h) => h.path === "docs/data.md")).toBe(false);
    expect(r.filesScanned).toBe(3);
  });

  it("cuts a large docs tree to the token budget, measured on the rendered block", async () => {
    for (let i = 0; i < 40; i++)
      await put(
        `docs/area-${String(i).padStart(2, "0")}.md`,
        `# Area ${i}\n\n## Deploy notes\n\nThe deploy of area ${i} uses the switch. ${"filler text ".repeat(80)}\n`,
      );
    // A counter that is not chars/4: the budget must hold under the counter given.
    const count = (t: string) => Math.ceil(t.length / 3);
    const r = await searchDocs(repo, "deploy switch", { maxTokens: 600, countTokens: count });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.tokensUsed).toBe(count(r.block));
    expect(count(r.block)).toBeLessThanOrEqual(600);
    expect(r.filesScanned).toBe(40);
  });

  it("returns nothing for an empty or missing tree, and nothing under a budget too small for the header", async () => {
    expect((await searchDocs(join(repo, "nope"), "deploy", { maxTokens: 500 })).hits).toEqual([]);
    await put("docs/runbook.md", RUNBOOK);
    const tiny = await searchDocs(repo, "deploy", { maxTokens: 5 });
    expect(tiny.hits).toEqual([]);
    expect(tiny.block).toBe("");
    expect(tiny.tokensUsed).toBe(0);
  });

  it("never renders a chunk with a credential shape", async () => {
    const fake = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"); // not-a-secret
    await put("docs/runbook.md", `# Runbook\n\n## Deploy\n\nDeploy with the token ${fake} set.\n`);
    const r = await searchDocs(repo, "deploy token", { maxTokens: 500 });
    expect(r.hits).toEqual([]);
    expect(r.excluded).toEqual([
      { path: "docs/runbook.md", heading: "Runbook > Deploy", reason: "secret shape" },
    ]);
    expect(renderDocHits([])).toBe("");
  });

  it("does not follow a docs/ root that is itself a symlink out of the tree", async () => {
    // Review w2-chat-memory finding 5.
    const outside = await mkdtemp(join(tmpdir(), "fr-memory-docs-outside-"));
    try {
      await mkdir(join(outside, "private"), { recursive: true });
      await writeFile(join(outside, "private", "notes.md"), "# Private\n\nhome notes\n", "utf8");
      await put("README.md", "# Game\n");
      try {
        await symlink(outside, join(repo, "docs"), "dir");
      } catch {
        return; // no symlink rights on this platform: nothing to check
      }
      expect((await collectDocFiles(repo)).map((f) => f.path)).toEqual(["README.md"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("searches several roots, the first winning on the same path, and selects again without reading", async () => {
    // Review w2-chat-memory findings 4 and 6: a linked folder plus the data-dir workspace.
    await put("docs/runbook.md", RUNBOOK);
    const workspace = await mkdtemp(join(tmpdir(), "fr-memory-docs-ws-"));
    try {
      await mkdir(join(workspace, "docs"), { recursive: true });
      await writeFile(
        join(workspace, "docs", "status.md"),
        "# Status\n\n## Next\n\nDeploy the leaderboard after the rollback drill.\n",
        "utf8",
      );
      await writeFile(join(workspace, "docs", "runbook.md"), "# Runbook\n\nshadowed deploy\n");
      const loaded = await loadDocChunks([repo, workspace]);
      expect(loaded.filesScanned).toBe(2);
      const r = selectDocHits(loaded, "deploy rollback", { maxTokens: 600 });
      expect(r.hits.map((h) => h.path).sort()).toEqual(["docs/runbook.md", "docs/status.md"]);
      expect(r.block).not.toContain("shadowed deploy");
      // The chunks are in memory: a second, smaller selection needs no file.
      await rm(workspace, { recursive: true, force: true });
      await rm(join(repo, "docs"), { recursive: true, force: true });
      const smaller = selectDocHits(loaded, "deploy rollback", { maxTokens: r.tokensUsed - 1 });
      expect(smaller.hits.length).toBeLessThan(r.hits.length);
      expect(smaller.tokensUsed).toBeLessThanOrEqual(r.tokensUsed - 1);
      const viaSearch = await searchDocs([repo], "deploy");
      expect(viaSearch.hits).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
