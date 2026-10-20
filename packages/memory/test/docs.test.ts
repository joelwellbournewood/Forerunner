import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fromPosix, join } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDocDrift,
  docFile,
  MAINTAINED_BY,
  parseDocFrontmatter,
  STANDARD_DOCS,
  scaffoldDocs,
} from "../src/docs.ts";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "fr-memory-docs-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const read = (rel: string) => readFile(join(repo, fromPosix(rel)), "utf8");

describe("standard doc set", () => {
  it("names the spec's eight docs in order", () => {
    expect([...STANDARD_DOCS]).toEqual([
      "README.md",
      "docs/overview.md",
      "docs/architecture.md",
      "docs/status.md",
      "docs/decisions/",
      "docs/runbook.md",
      "docs/data.md",
      "docs/testing.md",
    ]);
    expect(docFile("docs/decisions/")).toBe("docs/decisions/README.md");
    expect(docFile("docs/data.md")).toBe("docs/data.md");
  });

  it("scaffolds every missing doc from a template with maintained-by frontmatter", async () => {
    const res = await scaffoldDocs(repo, { name: "PharmaWatch", goal: "Watch pharma news." });
    expect(res.created).toEqual(STANDARD_DOCS.map(docFile));
    expect(res.existing).toEqual([]);
    for (const doc of STANDARD_DOCS) {
      const fm = parseDocFrontmatter(await read(docFile(doc)));
      expect(fm["maintained-by"]).toBe(MAINTAINED_BY);
      expect(fm.read_if?.length ?? 0).toBeGreaterThan(10);
    }
    const readme = await read("README.md");
    expect(readme).toContain("# PharmaWatch");
    expect(readme).toContain("Watch pharma news.");
    expect(readme.includes("\r")).toBe(false);
  });

  it("never touches an existing doc and is idempotent", async () => {
    await writeFile(join(repo, "README.md"), "# mine\n", "utf8");
    const first = await scaffoldDocs(repo, { name: "X" });
    expect(first.existing).toEqual(["README.md"]);
    expect(first.created).toHaveLength(STANDARD_DOCS.length - 1);
    expect(await read("README.md")).toBe("# mine\n");
    const second = await scaffoldDocs(repo, { name: "X" });
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual(STANDARD_DOCS.map(docFile));
  });

  it("parses doc frontmatter and tolerates its absence", () => {
    expect(
      parseDocFrontmatter('---\nmaintained-by: forerunner\nread_if: "a: b"\n---\n# T\n'),
    ).toEqual({
      "maintained-by": "forerunner",
      read_if: "a: b",
    });
    expect(parseDocFrontmatter("# No frontmatter\n")).toEqual({});
  });
});

describe("checkDocDrift", () => {
  it("expects status.md after a task change and after code changes, unless it was touched", async () => {
    await scaffoldDocs(repo, { name: "X" });
    const drift = await checkDocDrift(repo, { changedFiles: ["src/app.ts"], tasksChanged: true });
    expect(drift).toEqual([{ doc: "docs/status.md", reason: "a task changed state" }]);
    const code = await checkDocDrift(repo, { changedFiles: [{ path: "src/app.ts" }] });
    expect(code.map((d) => d.doc)).toEqual(["docs/status.md"]);
    const satisfied = await checkDocDrift(repo, {
      changedFiles: ["src/app.ts", "docs/status.md"],
      tasksChanged: true,
    });
    expect(satisfied).toEqual([]);
    const docsOnly = await checkDocDrift(repo, { changedFiles: ["docs/overview.md", "README.md"] });
    expect(docsOnly).toEqual([]);
  });

  it("expects architecture.md when the source layout changes, with either path separator", async () => {
    await scaffoldDocs(repo, { name: "X" });
    const modified = await checkDocDrift(repo, {
      changedFiles: [{ path: "src/a.ts", kind: "modified" }, "docs/status.md"],
    });
    expect(modified).toEqual([]);
    const added = await checkDocDrift(repo, {
      changedFiles: [{ path: "src\\new\\thing.ts", kind: "added" }, "docs/status.md"],
    });
    expect(added).toEqual([
      { doc: "docs/architecture.md", reason: expect.stringMatching(/added src\/new\/thing\.ts/) },
    ]);
    const removed = await checkDocDrift(repo, {
      changedFiles: [
        { path: "packages/x/old.ts", kind: "removed" },
        "docs/status.md",
        "docs/architecture.md",
      ],
    });
    expect(removed).toEqual([]);
  });

  it("expects decisions/ when an ADR-worthy change is flagged and no decision file changed", async () => {
    await scaffoldDocs(repo, { name: "X" });
    const flagged = await checkDocDrift(repo, {
      changedFiles: ["docs/status.md"],
      adrWorthy: "switched the queue from SQLite to Postgres",
    });
    expect(flagged).toEqual([
      { doc: "docs/decisions/", reason: "switched the queue from SQLite to Postgres" },
    ]);
    const done = await checkDocDrift(repo, {
      changedFiles: ["docs/status.md", "docs/decisions/0003-queue.md"],
      adrWorthy: true,
    });
    expect(done).toEqual([]);
  });

  it("expects data.md for schema changes and testing.md for test infrastructure changes", async () => {
    await scaffoldDocs(repo, { name: "X" });
    const data = await checkDocDrift(repo, {
      changedFiles: ["db/migrations/0002-add-lesson.sql", "docs/status.md"],
    });
    expect(data.map((d) => d.doc)).toEqual(["docs/data.md"]);
    const testing = await checkDocDrift(repo, {
      changedFiles: ["vitest.config.ts", "docs/status.md"],
    });
    expect(testing.map((d) => d.doc)).toEqual(["docs/testing.md"]);
  });

  it("reports every standard doc that is missing from the repo", async () => {
    const drift = await checkDocDrift(repo, { changedFiles: [] });
    expect(drift.map((d) => d.doc)).toEqual([...STANDARD_DOCS]);
    for (const d of drift) expect(d.reason).toBe("missing from the standard doc set");
  });
});
