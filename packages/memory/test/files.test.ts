import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isForerunnerError, join } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HashedNgramEmbedder } from "../src/embedding.ts";
import {
  exportRow,
  FRONTMATTER_KEYS,
  lintLesson,
  mirrorRow,
  parseLesson,
  reconcile,
  serializeLesson,
} from "../src/files.ts";
import type { LessonDoc } from "../src/types.ts";
import { TEXTS, type World, world } from "./helpers.ts";

function doc(over: Partial<LessonDoc> = {}): LessonDoc {
  return {
    id: "01960000-0000-7000-8000-000000000001",
    scope: "shared",
    owner_agent_id: null,
    project_id: null,
    text: TEXTS.windows,
    source: "session:ses_1",
    tags: ["ci", "windows"],
    confidence: 0.7,
    last_used: null,
    hit_count: 0,
    superseded_by: null,
    pinned: false,
    status: "active",
    created_at: "2026-03-02T07:00:00.000Z",
    updated_at: "2026-03-02T07:00:00.000Z",
    author_agent: null,
    author_human: null,
    version: 1,
    flags: [],
    ...over,
  };
}

describe("lesson file format", () => {
  it("serialises with sorted frontmatter keys, LF only and a trailing newline", () => {
    const text = serializeLesson(doc({ flags: ["contradiction:b", "contradiction:a"] }));
    expect(text.startsWith("---\n")).toBe(true);
    expect(text.includes("\r")).toBe(false);
    expect(text.endsWith(`${TEXTS.windows}\n`)).toBe(true);
    const header = text.slice(4, text.indexOf("\n---\n"));
    const keys = header.split("\n").map((l) => l.slice(0, l.indexOf(":")));
    expect(keys).toEqual([...FRONTMATTER_KEYS]);
    expect(header).toContain("flags: [contradiction:a, contradiction:b]");
    expect(header).toContain("tags: [ci, windows]");
    expect(header).toContain("format: 1");
  });

  it("round-trips through parse, quoting what needs quoting", () => {
    const original = doc({
      text: 'First line of the lesson.\n\nSecond paragraph: with a colon and "quotes".',
      author_human: "hum one",
      source: "review:rev_1;session:ses_2",
      last_used: "2026-03-03T08:00:00.000Z",
      hit_count: 4,
      pinned: true,
      flags: ["contradiction:x"],
    });
    const parsed = parseLesson(serializeLesson(original));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.doc).toEqual(original);
    expect(parsed.format).toBe(1);
  });

  it("accepts CRLF on read and normalises the body to LF", () => {
    const crlf = serializeLesson(doc()).replace(/\n/g, "\r\n");
    const parsed = parseLesson(crlf);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.doc.text).toBe(TEXTS.windows);
  });

  it("rejects unknown, duplicate and missing keys, and other malformed files", () => {
    const good = serializeLesson(doc());
    const fail = (text: string) => {
      const p = parseLesson(text);
      return p.ok ? "ok" : p.error;
    };
    expect(fail(good.replace("\nid: ", "\nread_if: x\nid: "))).toMatch(/unknown frontmatter key/);
    expect(fail(good.replace("\nid: ", "\nid: other\nid: "))).toMatch(/duplicate frontmatter key/);
    expect(fail(good.replace(/\ntags: [^\n]*/, ""))).toMatch(/missing frontmatter key: tags/);
    expect(fail("no frontmatter here\n")).toMatch(/missing frontmatter/);
    expect(fail(good.replace(`${TEXTS.windows}\n`, "\n"))).toMatch(/body is empty/);
    expect(fail(good.replace("format: 1", "format: 2"))).toMatch(/newer/);
    expect(fail(good.replace("confidence: 0.7", "confidence: 1.5"))).toMatch(/confidence/);
    expect(fail(good.replace("scope: shared", "scope: agent_private"))).toMatch(/owner_agent_id/);
    expect(fail(good.replace("scope: shared", "scope: nope"))).toMatch(/scope must be/);
  });

  it("lints text length, tags, confidence, secret shapes and machine paths", () => {
    expect(lintLesson(doc())).toEqual([]);
    expect(lintLesson(doc({ text: "too short" }))).toEqual([
      expect.stringMatching(/text must be 20-2000/),
    ]);
    expect(lintLesson(doc({ tags: ["Windows", "ci", "ci"] }))).toEqual([
      expect.stringMatching(/bad tag: Windows/),
      "duplicate tags",
    ]);
    expect(lintLesson(doc({ confidence: 1.2 }))).toContain("confidence outside 0..1");
    const token = ["ghp_", "A".repeat(36)].join(""); // not-a-secret
    expect(
      lintLesson(doc({ text: `Use ${token} for the mirror and keep it out of the logs.` })),
    ).toContain("text contains a secret shape");
    const withPath = "Edit /home/alice/.config/forerunner/settings.json before the first session.";
    expect(lintLesson(doc({ text: withPath }))).toContain(
      "critic and shared lessons must not name a home-directory path",
    );
    expect(
      lintLesson(doc({ scope: "agent_private", owner_agent_id: "agt_a", text: withPath })),
    ).toEqual([]);
    expect(lintLesson(doc({ owner_agent_id: "agt_a" }))).toContain(
      "non-private lesson with an owner",
    );
  });
});

describe("LessonFiles", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it("keeps one root per scope and refuses paths outside the memory root", () => {
    expect(w.files.scopeRoot("agent_private", w.alice)).toBe(join(w.root, "agents", w.alice));
    expect(w.files.scopeRoot("critic")).toBe(join(w.root, "critic"));
    expect(w.files.scopeRoot("shared")).toBe(join(w.root, "shared"));
    expect(() => w.files.scopeRoot("agent_private")).toThrow(/owner agent id/);
    expect(() => w.files.scopeRoot("agent_private", "../x")).toThrow(/safe path segment/);
    expect(() => w.files.pathFor("shared", null, "../../etc")).toThrow(/safe path segment/);
    try {
      w.files.inside(join(w.root, "..", "elsewhere.md"));
      throw new Error("expected a throw");
    } catch (e) {
      expect(isForerunnerError(e, "path_not_allowed")).toBe(true);
    }
  });

  it("writes atomically, reads back and lists per scope and owner", async () => {
    const shared = doc();
    const target = await w.files.write(shared);
    expect(target).toBe(join(w.root, "shared", "lessons", `${shared.id}.md`));
    expect(await readdir(join(w.root, "shared", "lessons"))).toEqual([`${shared.id}.md`]);
    expect((await readFile(target, "utf8")).includes("\r")).toBe(false);
    expect(await w.files.read(target)).toEqual(shared);

    const mine = doc({
      id: "01960000-0000-7000-8000-000000000002",
      scope: "agent_private",
      owner_agent_id: w.alice,
    });
    await w.files.write(mine);
    expect((await w.files.list("shared")).lessons.map((l) => l.doc.id)).toEqual([shared.id]);
    expect((await w.files.list("agent_private", w.alice)).lessons.map((l) => l.doc.id)).toEqual([
      mine.id,
    ]);
    expect((await w.files.list("agent_private", w.bob)).lessons).toEqual([]);
    expect(await w.files.exists(target)).toBe(true);
    expect(await w.files.remove(target)).toBe(true);
    expect(await w.files.remove(target)).toBe(false);
  });

  it("reports files that do not parse or sit under the wrong name instead of trusting them", async () => {
    const dir = join(w.root, "shared", "lessons");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "wrong-name.md"), serializeLesson(doc()), "utf8");
    await writeFile(join(dir, "garbage.md"), "not a lesson\n", "utf8");
    const listed = await w.files.list("shared");
    expect(listed.lessons).toEqual([]);
    expect(listed.invalid.map((i) => i.error).sort()).toEqual([
      expect.stringMatching(/does not match id/),
      expect.stringMatching(/missing frontmatter/),
    ]);
  });

  it("reads the agent's instructions.md as LF, empty when missing", async () => {
    expect(await w.files.readInstructions(w.alice)).toBe("");
    await mkdir(w.files.scopeRoot("agent_private", w.alice), { recursive: true });
    await writeFile(
      join(w.files.scopeRoot("agent_private", w.alice), "instructions.md"),
      "Prefer small PRs.\r\nAsk before spending.\r\n",
      "utf8",
    );
    expect(await w.files.readInstructions(w.alice)).toBe(
      "Prefer small PRs.\nAsk before spending.\n",
    );
  });
});

describe("reconcile", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it("rebuilds rows from files, flags orphans, and is idempotent", async () => {
    const a = doc({
      id: "01960000-0000-7000-8000-00000000000a",
      scope: "agent_private",
      owner_agent_id: w.alice,
    });
    const b = doc({
      id: "01960000-0000-7000-8000-00000000000b",
      scope: "agent_private",
      owner_agent_id: w.alice,
      text: TEXTS.vault,
      tags: ["vault"],
      version: 3,
    });
    const pathA = await w.files.write(a);
    await w.files.write(b);
    const orphan = await w.store.lesson.add({
      scope: "agent_private",
      owner_agent_id: w.alice,
      text: "A row without a file is an orphan of the index.",
    });

    const first = await reconcile(
      w.files,
      w.store.lesson,
      w.ctx.embedder,
      "agent_private",
      w.alice,
    );
    expect(first.upserted).toEqual([a.id, b.id]);
    expect(first.unchanged).toEqual([]);
    expect(first.orphans).toEqual([orphan.id]);
    expect(first.invalid).toEqual([]);
    const rowA = await w.store.lesson.mustGet(a.id);
    expect(rowA.text).toBe(TEXTS.windows);
    expect(rowA.file_path).toBe(pathA);
    expect(rowA.embedding?.length).toBe(256);
    expect(rowA.created_at).toBe(a.created_at);
    const rowB = await w.store.lesson.mustGet(b.id);
    expect(rowB.version).toBe(3);
    expect(rowB.tags).toEqual(["vault"]);
    expect(await w.store.lesson.get(orphan.id)).toBeDefined();

    const second = await reconcile(
      w.files,
      w.store.lesson,
      w.ctx.embedder,
      "agent_private",
      w.alice,
      {
        deleteOrphans: true,
      },
    );
    expect(second.upserted).toEqual([]);
    expect(second.unchanged).toEqual([a.id, b.id]);
    expect(second.orphans).toEqual([orphan.id]);
    expect(await w.store.lesson.get(orphan.id)).toBeUndefined();

    const catalog = await readFile(join(w.root, "agents", w.alice, "catalog.md"), "utf8");
    expect(catalog).toContain(a.id);
    expect(catalog).toContain(b.id);
    expect(catalog).toContain("Generated by Forerunner");
  });

  it("heals a crash between the file write and the row write, and re-embeds a changed file", async () => {
    const a = doc({ id: "01960000-0000-7000-8000-00000000000c" });
    const path = await w.files.write(a);
    // Crash: the file exists, the row never landed.
    expect(await w.store.lesson.get(a.id)).toBeUndefined();
    expect((await reconcile(w.files, w.store.lesson, w.ctx.embedder, "shared")).upserted).toEqual([
      a.id,
    ]);
    // A human edits the file: the row follows on the next reconcile.
    await w.files.write({ ...a, text: TEXTS.vitest, version: 2 });
    const report = await reconcile(w.files, w.store.lesson, w.ctx.embedder, "shared");
    expect(report.upserted).toEqual([a.id]);
    const row = await w.store.lesson.mustGet(a.id);
    expect(row.text).toBe(TEXTS.vitest);
    expect(row.version).toBe(2);
    expect(row.file_path).toBe(path);
    const expected = Array.from(w.ctx.embedder.embed(TEXTS.vitest));
    expect(row.embedding?.length).toBe(expected.length);
    expect(Math.abs((row.embedding?.[0] ?? 0) - (expected[0] ?? 0))).toBeLessThan(1e-5);
  });

  it("reports an invalid file and still indexes the rest", async () => {
    const a = doc({ id: "01960000-0000-7000-8000-00000000000d" });
    await w.files.write(a);
    await writeFile(join(w.root, "shared", "lessons", "broken.md"), "---\nid: x\n", "utf8");
    const report = await reconcile(w.files, w.store.lesson, w.ctx.embedder, "shared");
    expect(report.upserted).toEqual([a.id]);
    expect(report.invalid).toEqual([
      {
        path: join(w.root, "shared", "lessons", "broken.md"),
        error: expect.stringMatching(/frontmatter/),
      },
    ]);
  });

  it("exportRow keeps the flags the file already carries", async () => {
    const a = doc({ id: "01960000-0000-7000-8000-00000000000e", flags: ["contradiction:z"] });
    const path = await w.files.write(a);
    const row = await mirrorRow(w.store.lesson, a, path, w.ctx.embedder);
    expect(row.version).toBe(1);
    await exportRow(w.files, { ...row, hit_count: 7 });
    const again = await w.files.read(path);
    expect(again.flags).toEqual(["contradiction:z"]);
    expect(again.hit_count).toBe(7);
    await exportRow(w.files, row, []);
    expect((await w.files.read(path)).flags).toEqual([]);
  });
});

/** Critic findings on the first build: lint scope of the path rule, embedder change detection. */
describe("lint path rule", () => {
  it("refuses home-directory paths in critic and shared lessons but allows generic system paths", () => {
    const refused = [
      "Edit /home/alice/.config/forerunner/settings.json before the first session.",
      "The build cache lives in /Users/bob/Library/Caches/forerunner and fills the disk.",
      "Never commit the file under /root/.ssh that the installer leaves behind.",
      "Open C:\\Users\\alice\\AppData\\Roaming\\forerunner\\settings.json to change the port.",
    ];
    for (const text of refused) {
      expect(lintLesson(doc({ text }))).toEqual([
        "critic and shared lessons must not name a home-directory path",
      ]);
      expect(lintLesson(doc({ scope: "agent_private", owner_agent_id: "agt_a", text }))).toEqual(
        [],
      );
    }
    const allowed = [
      "Tests must not write to /tmp/ directly; create a temp directory per test instead.",
      "The service logs under /var/log/forerunner rotate daily; check there before the journal.",
      "Mount the dataset at /mnt/data read-only and point the pipeline at D:\\build\\out on Windows.",
      "Install the runner under /opt/forerunner so the updater can replace it atomically.",
    ];
    for (const text of allowed) expect(lintLesson(doc({ text }))).toEqual([]);
  });
});

describe("reconcile (embedder change)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it("re-embeds every file when the index was built by another embedder of the same width", async () => {
    const a = doc({ id: "01960000-0000-7000-8000-00000000001a" });
    const b = doc({ id: "01960000-0000-7000-8000-00000000001b", text: TEXTS.vault });
    await w.files.write(a);
    await w.files.write(b);
    const first = await reconcile(w.files, w.store.lesson, w.ctx.embedder, "shared");
    expect(first.upserted).toEqual([a.id, b.id]);
    expect(first.embedder).toEqual({
      name: w.ctx.embedder.name,
      previous: null,
      reembedded: true,
    });
    const meta = await w.files.readIndexMeta("shared");
    expect(meta).toEqual({ embedder: w.ctx.embedder.name, dims: 256, format: 1 });
    const before = (await w.store.lesson.mustGet(a.id)).embedding as number[];

    const other = new HashedNgramEmbedder({ minGram: 2, maxGram: 4 });
    expect(other.dims).toBe(w.ctx.embedder.dims);
    expect(other.name).not.toBe(w.ctx.embedder.name);
    const second = await reconcile(w.files, w.store.lesson, other, "shared");
    expect(second.upserted).toEqual([a.id, b.id]);
    expect(second.unchanged).toEqual([]);
    expect(second.embedder).toEqual({
      name: other.name,
      previous: w.ctx.embedder.name,
      reembedded: true,
    });
    const after = (await w.store.lesson.mustGet(a.id)).embedding as number[];
    expect(after).not.toEqual(before);
    expect(Math.abs((after[0] ?? 0) - (other.embed(a.text)[0] ?? 0))).toBeLessThan(1e-5);
    expect((await w.files.readIndexMeta("shared"))?.embedder).toBe(other.name);

    const third = await reconcile(w.files, w.store.lesson, other, "shared");
    expect(third.upserted).toEqual([]);
    expect(third.unchanged).toEqual([a.id, b.id]);
    expect(third.embedder.reembedded).toBe(false);
    expect(await w.files.readIndexMeta("agent_private", w.alice)).toBeNull();
  });
});
