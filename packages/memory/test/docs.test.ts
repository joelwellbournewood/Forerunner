import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fromPosix, join } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStatusUpdate,
  checkDocDrift,
  docFile,
  MAINTAINED_BY,
  MAX_STATUS_SESSIONS,
  parseDocFrontmatter,
  renderStandardDoc,
  STANDARD_DOCS,
  STATUS_DOC,
  type StatusUpdate,
  scaffoldDocs,
  writeStatusUpdate,
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

  it("renders a doc's template with the project's name, goal and repos; scaffold writes exactly that", async () => {
    const info = { name: "PharmaWatch", goal: "Watch pharma news.", repos: ["acme/pharma"] };
    const readme = renderStandardDoc("README.md", info);
    expect(readme.startsWith("---\n")).toBe(true);
    expect(readme).toContain("# PharmaWatch");
    expect(readme).toContain("Watch pharma news.");
    expect(readme).toContain("- acme/pharma");
    expect(renderStandardDoc("docs/overview.md", info)).toContain("acme/pharma");
    await scaffoldDocs(repo, info);
    expect(await read("README.md")).toBe(readme);
    expect(await read("docs/decisions/README.md")).toBe(renderStandardDoc("docs/decisions/", info));
    // Without repositories the section is left out rather than printed empty.
    expect(renderStandardDoc("README.md", { name: "X" })).not.toContain("## Repositories");
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

describe("status.md updates", () => {
  const update: StatusUpdate = {
    sessionId: "0192a1b2-0000-7000-8000-000000000001",
    endedAt: "2026-10-20T09:30:00.000Z",
    done: ["Add clamp"],
    inFlight: ["Write the runbook"],
    blocked: ["Deploy to staging"],
    next: ["Add retries"],
    note: "stop reason completed, spent $0.30",
  };

  it("starts from the template when the doc is missing and writes the four sections plus a dated session entry", () => {
    const text = applyStatusUpdate(null, update);
    expect(parseDocFrontmatter(text)["maintained-by"]).toBe(MAINTAINED_BY);
    expect(text).toContain("# Status\n");
    expect(text).toMatch(/## Done\n\n- Add clamp\n/);
    expect(text).toMatch(/## In flight\n\n- Write the runbook\n/);
    expect(text).toMatch(/## Blocked\n\n- Deploy to staging\n/);
    expect(text).toMatch(/## Next\n\n- Add retries\n/);
    expect(text).toContain("## Sessions\n");
    expect(text).toContain(`### 2026-10-20 session ${update.sessionId}\n`);
    expect(text).toContain("- Done: Add clamp\n");
    expect(text).toContain("- In flight: Write the runbook\n");
    expect(text).toContain("- Blocked: Deploy to staging\n");
    expect(text).toContain("- Next: Add retries\n");
    expect(text).toContain("- Note: stop reason completed, spent $0.30\n");
    expect(text.includes("\r")).toBe(false);
    expect(text.endsWith("\n")).toBe(true);
    // The placeholders of the template are gone.
    expect(text).not.toContain("nothing yet");
  });

  it("rewrites only the four standard sections, keeps every other section and the frontmatter, and lists newest sessions first", () => {
    const existing = [
      "---",
      "maintained-by: human",
      'read_if: "custom"',
      "---",
      "# Project status",
      "",
      "Intro paragraph the human wrote.",
      "",
      "## Done",
      "",
      "- old item",
      "",
      "## Risks",
      "",
      "- the human's own section",
      "",
      "## Next",
      "",
      "- old next",
      "",
      "## Sessions",
      "",
      "### 2026-10-19 session earlier",
      "",
      "- Done: something earlier",
      "",
    ].join("\n");
    const text = applyStatusUpdate(existing, { ...update, note: undefined });
    expect(text.startsWith('---\nmaintained-by: human\nread_if: "custom"\n---\n')).toBe(true);
    expect(text).toContain("# Project status\n\nIntro paragraph the human wrote.\n");
    expect(text).toContain("## Risks\n\n- the human's own section\n");
    expect(text).not.toContain("old item");
    expect(text).not.toContain("old next");
    // Sections the doc lacked are added before the session log.
    const order = [
      "## Done",
      "## Risks",
      "## Next",
      "## In flight",
      "## Blocked",
      "## Sessions",
    ].map((h) => text.indexOf(`${h}\n`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const mine = text.indexOf(`### 2026-10-20 session ${update.sessionId}`);
    const earlier = text.indexOf("### 2026-10-19 session earlier");
    expect(mine).toBeGreaterThan(0);
    expect(earlier).toBeGreaterThan(mine);
    expect(text).toContain("- Done: something earlier");
    expect(text).not.toContain("- Note:");
  });

  it("is idempotent per session, prints none for an empty list, uses the project state for the sections when given, and caps the log", () => {
    const once = applyStatusUpdate(null, update);
    const twice = applyStatusUpdate(once, update);
    expect(twice).toBe(once);
    const empty = applyStatusUpdate(null, {
      ...update,
      done: [],
      inFlight: [],
      blocked: [],
      next: [],
      note: undefined,
    });
    expect(empty).toMatch(/## Done\n\n- nothing\n/);
    expect(empty).toContain("- Done: none\n");
    const withState = applyStatusUpdate(null, {
      ...update,
      state: {
        done: ["Earlier task", "Add clamp"],
        inFlight: [],
        blocked: [],
        next: ["Add retries", "Ship"],
      },
    });
    expect(withState).toMatch(/## Done\n\n- Earlier task\n- Add clamp\n/);
    expect(withState).toMatch(/## In flight\n\n- nothing\n/);
    expect(withState).toContain("- Done: Add clamp\n");
    expect(withState).toContain("- In flight: Write the runbook\n");
    let text: string | null = null;
    for (let i = 0; i < MAX_STATUS_SESSIONS + 5; i++) {
      text = applyStatusUpdate(text, {
        ...update,
        sessionId: `s-${i}`,
        endedAt: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`,
      });
    }
    expect((text ?? "").match(/^### /gm)).toHaveLength(MAX_STATUS_SESSIONS);
    expect(text).toContain(`session s-${MAX_STATUS_SESSIONS + 4}`);
    expect(text).not.toContain("session s-0\n");
    // Titles are one line each and bounded.
    const long = applyStatusUpdate(null, { ...update, done: [`multi\nline ${"x".repeat(300)}`] });
    expect(long).not.toMatch(/- multi\n/);
    expect(long).toMatch(/- multi line x+\.\.\.\n/);
  });

  it("writes docs/status.md on disk, scaffolding it first when missing, and touches no other doc", async () => {
    const first = await writeStatusUpdate(repo, update);
    expect(first).toMatchObject({ path: STATUS_DOC, created: true });
    expect(await read(STATUS_DOC)).toBe(first.content);
    expect(first.content).toContain(`session ${update.sessionId}`);
    const drift = await checkDocDrift(repo, { changedFiles: [] });
    expect(drift.map((d) => d.doc)).not.toContain("docs/status.md");
    expect(drift.map((d) => d.doc)).toContain("README.md");
    const second = await writeStatusUpdate(repo, { ...update, sessionId: "later", done: ["Ship"] });
    expect(second.created).toBe(false);
    expect(second.content).toContain("### 2026-10-20 session later");
    expect(second.content).toContain(`session ${update.sessionId}`);
    expect(await read(STATUS_DOC)).toBe(second.content);
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
