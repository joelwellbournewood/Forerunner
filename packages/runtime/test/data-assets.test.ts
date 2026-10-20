import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isInside, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { DataAssets, normalizeKind, safeFileName } from "../src/data/assets.ts";
import {
  detectEncoding,
  inferScalarType,
  jpegDimensions,
  mergeTypes,
  parseCsv,
  parseUri,
  pngDimensions,
  sniffDelimiter,
  sniffFormat,
} from "../src/data/metadata.ts";
import { DEFAULT_DATA_LIMITS, resolveDataLimits } from "../src/data/types.ts";
import {
  agent,
  csvText,
  type DataHarness,
  dataHarness,
  human,
  jpegBytes,
  jsonlText,
  pngBytes,
  writeFixture,
} from "./data-helpers.ts";

describe("data assets: registration kinds", () => {
  let h: DataHarness;
  afterEach(async () => {
    await h?.close();
  });

  it("registers a file by path (linked): row, view, project link and an audit row", async () => {
    h = await dataHarness();
    const p = writeFixture(join(h.src, "notes.txt"), "hello\nworld\n");
    const view = await h.assets.register({ projectId: h.projectId, source: p }, human);
    expect(view.kind).toBe("file");
    expect(view.storage).toBe("linked");
    expect(view.locator).toBe(p);
    expect(view.name).toBe("notes.txt");
    expect(view.sizeBytes).toBe(12);
    expect(view.format).toBe("text");
    expect(view.mime).toBe("text/plain");
    expect(view.available).toBe(true);
    expect(view.registeredBy).toBe("h-1");
    expect(view.note).toBeNull();
    const row = await h.store.dataAsset.mustGet(view.id);
    expect(row.project_ids).toEqual([h.projectId]);
    expect(row.author_human).toBe("h-1");
    const project = await h.store.project.mustGet(h.projectId);
    expect(project.data_assets).toEqual([view.id]);
    const audit = await h.store.auditLog.list({ tool: "data.register" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.human_id).toBe("h-1");
    expect(audit[0]?.allowed).toBe(true);
    expect(await h.assets.list(h.projectId)).toHaveLength(1);
    expect(await h.assets.list(h.otherProjectId)).toHaveLength(0);
  });

  it("registers a folder: entry count, extension histogram and an entries sample; symlinks skipped", async () => {
    h = await dataHarness();
    const root = join(h.src, "corpus");
    writeFixture(join(root, "a.csv"), "x,y\n1,2\n");
    writeFixture(join(root, "sub", "b.csv"), "x,y\n3,4\n");
    writeFixture(join(root, "sub", "c.md"), "# c\n");
    writeFixture(join(root, "node_modules", "dep.js"), "ignored");
    const view = await h.assets.register({ projectId: h.projectId, source: root }, agent);
    expect(view.kind).toBe("folder");
    expect(view.format).toBe("folder");
    expect(view.storage).toBe("linked");
    expect(view.registeredBy).toBe("alice");
    expect(view.metadata?.entries).toBe(3);
    expect(view.metadata?.extensions).toEqual({ ".csv": 2, ".md": 1 });
    expect(view.sizeBytes).toBe(8 + 8 + 4);
    expect(view.sample?.kind).toBe("entries");
    expect(view.sample?.entries?.[0]).toMatch(/^a\.csv/);
    expect(view.sample?.entries).toHaveLength(3);
    await expect(
      h.assets.register({ projectId: h.projectId, source: root, kind: "file" }, human),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("registers a dataset by URI without touching the filesystem or the network", async () => {
    h = await dataHarness();
    const view = await h.assets.register(
      {
        projectId: h.projectId,
        source: "s3://my-bucket/exports/2026/events.parquet",
        sizeBytes: 123_456_789,
      },
      human,
    );
    expect(view.kind).toBe("dataset");
    expect(view.storage).toBe("remote");
    expect(view.name).toBe("events.parquet");
    expect(view.format).toBe("parquet");
    expect(view.sizeBytes).toBe(123_456_789);
    expect(view.metadata?.scheme).toBe("s3");
    expect(view.metadata?.host).toBe("my-bucket");
    expect(view.available).toBe(true);
    expect(view.note).toMatch(/never fetches/);
    const sample = await h.assets.sample(view.id);
    expect(sample.kind).toBe("none");
    await expect(
      h.assets.register({ projectId: h.projectId, source: "r2://b/x.csv", mode: "copy" }, human),
    ).rejects.toMatchObject({ code: "not_supported" });
    await expect(
      h.assets.register({ projectId: h.projectId, source: "ftp://host/x.csv" }, human),
    ).rejects.toMatchObject({ code: "validation" });
    expect(parseUri("gs://bucket/a/b.csv?x=1")).toEqual({
      scheme: "gs",
      host: "bucket",
      name: "b.csv",
    });
    expect(parseUri("C:\\data\\x.csv")).toBeNull();
  });

  it("copy mode puts a copy under <projectsRoot>/<project>/data and leaves the original untouched", async () => {
    h = await dataHarness();
    const p = writeFixture(join(h.src, "small.csv"), csvText(3));
    const before = statSync(p).mtimeMs;
    const view = await h.assets.register(
      { projectId: h.projectId, source: p, mode: "copy" },
      human,
    );
    expect(view.storage).toBe("copied");
    const dataDir = h.assets.projectDataDir(h.projectId);
    expect(isInside(join(h.projectsRoot, h.projectId, "data"), dataDir)).toBe(true);
    expect(isInside(dataDir, view.locator)).toBe(true);
    expect(basename(view.locator)).toBe(`${view.id}-small.csv`);
    expect(readFileSync(view.locator, "utf8")).toBe(csvText(3));
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mtimeMs).toBe(before);
    // Registering something already inside the data dir is a copy by definition, not another copy.
    const again = await h.assets.register(
      { projectId: h.projectId, source: view.locator, mode: "copy" },
      human,
    );
    expect(again.storage).toBe("copied");
    expect(again.locator).toBe(view.locator);
    // Folders copy too, file by file.
    const folder = join(h.src, "tiny");
    writeFixture(join(folder, "a.txt"), "a");
    writeFixture(join(folder, "deep", "b.txt"), "bb");
    const fv = await h.assets.register(
      { projectId: h.projectId, source: folder, mode: "copy" },
      human,
    );
    expect(fv.storage).toBe("copied");
    expect(readFileSync(join(fv.locator, "deep", "b.txt"), "utf8")).toBe("bb");
  });

  it("large files are linked, never copied, with a note about LFS and R2", async () => {
    h = await dataHarness({ copyThresholdBytes: 1000 });
    const p = writeFixture(join(h.src, "big.csv"), csvText(200));
    expect(statSync(p).size).toBeGreaterThan(1000);
    const view = await h.assets.register(
      { projectId: h.projectId, source: p, mode: "copy" },
      human,
    );
    expect(view.storage).toBe("linked");
    expect(view.locator).toBe(p);
    expect(view.note).toMatch(/Git LFS/);
    expect(view.note).toMatch(/r2:\/\//);
    expect(existsSync(h.assets.projectDataDir(h.projectId))).toBe(false);
    const folder = join(h.src, "bigfolder");
    writeFixture(join(folder, "x.bin"), new Uint8Array(1500));
    const fv = await h.assets.register(
      { projectId: h.projectId, source: folder, mode: "copy" },
      human,
    );
    expect(fv.storage).toBe("linked");
    expect(fv.note).toMatch(/above the copy threshold/);
  });

  it("validates sources: relative paths, missing paths, kind mismatches, unknown projects", async () => {
    h = await dataHarness();
    await expect(
      h.assets.register({ projectId: h.projectId, source: "relative/x.csv" }, human),
    ).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      h.assets.register({ projectId: h.projectId, source: join(h.src, "missing.csv") }, human),
    ).rejects.toMatchObject({ code: "not_found" });
    const p = writeFixture(join(h.src, "f.csv"), "a\n1\n");
    await expect(
      h.assets.register({ projectId: h.projectId, source: p, kind: "folder" }, human),
    ).rejects.toMatchObject({
      code: "validation",
    });
    await expect(h.assets.register({ projectId: "nope", source: p }, human)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      h.assets.register({ projectId: h.projectId, source: "   " }, human),
    ).rejects.toMatchObject({
      code: "validation",
    });
    await expect(h.assets.get("nope")).rejects.toMatchObject({ code: "not_found" });
    expect(normalizeKind("csv")).toBe("file");
    expect(normalizeKind("folder")).toBe("folder");
    expect(normalizeKind("dataset")).toBe("dataset");
    expect(normalizeKind(undefined)).toBeUndefined();
    expect(safeFileName("../../evil name:?.csv")).toBe("evil name__.csv");
    expect(safeFileName("CON")).toBe("_CON");
    expect(resolveDataLimits({ copyThresholdBytes: 10 }).uploadMaxBytes).toBe(10);
    expect(() => resolveDataLimits({ sampleBytes: 0 })).toThrow(/positive/);
  });

  it("defaults the projects root to appDirs().data/projects (FORERUNNER_HOME honoured)", async () => {
    h = await dataHarness();
    const prev = process.env.FORERUNNER_HOME;
    process.env.FORERUNNER_HOME = h.dir;
    try {
      const a = new DataAssets({ store: h.store, clock: h.clock });
      expect(a.projectDataDir("p-1")).toBe(join(h.dir, "data", "projects", "p-1", "data"));
      expect(a.limits).toEqual(DEFAULT_DATA_LIMITS);
    } finally {
      if (prev === undefined) delete process.env.FORERUNNER_HOME;
      else process.env.FORERUNNER_HOME = prev;
    }
  });
});

describe("data assets: metadata", () => {
  let h: DataHarness;
  afterEach(async () => {
    await h?.close();
  });

  it("csv: delimiter, columns with inferred types, exact row count and a stored sample", async () => {
    h = await dataHarness();
    const p = writeFixture(join(h.src, "items.csv"), csvText(40));
    const view = await h.assets.register({ projectId: h.projectId, source: p }, human);
    expect(view.format).toBe("csv");
    expect(view.mime).toBe("text/csv");
    expect(view.metadata?.encoding).toBe("utf-8");
    expect(view.metadata?.delimiter).toBe(",");
    expect(view.metadata?.rowCount).toBe(40);
    expect(view.metadata?.rowCountExact).toBe(true);
    expect(view.metadata?.columns).toEqual([
      { name: "id", type: "integer" },
      { name: "name", type: "string" },
      { name: "price", type: "number" },
      { name: "active", type: "boolean" },
      { name: "when", type: "date" },
    ]);
    expect(view.sample?.kind).toBe("rows");
    expect(view.sample?.rows).toHaveLength(DEFAULT_DATA_LIMITS.storedSampleRows);
    expect(view.sample?.rows?.[0]).toEqual({
      id: "1",
      name: "item 1",
      price: "1.50",
      active: "false",
      when: "2026-01-02",
    });
    expect(view.sample?.truncated).toBe(true);
    // Semicolons and tabs are sniffed; quoted newlines stay inside the field.
    const semi = writeFixture(join(h.src, "semi.csv"), 'a;b\n"x;y";"line1\nline2"\n');
    const sv = await h.assets.register({ projectId: h.projectId, source: semi }, human);
    expect(sv.metadata?.delimiter).toBe(";");
    expect(sv.sample?.rows?.[0]).toEqual({ a: "x;y", b: "line1\nline2" });
    expect(sniffDelimiter("a\tb\tc")).toBe("\t");
    expect(parseCsv('a,b\n"1,5","""x"""\n', ",", 10).rows).toEqual([
      ["a", "b"],
      ["1,5", '"x"'],
    ]);
    expect(inferScalarType("NaN")).toBe("empty");
    expect(mergeTypes(["integer", "number", "empty"])).toBe("number");
    expect(mergeTypes(["integer", "string"])).toBe("mixed");
  });

  it("csv above the row-count limit gets an estimated count flagged as inexact", async () => {
    h = await dataHarness({ rowCountMaxBytes: 2000, headBytes: 2000 });
    const p = writeFixture(join(h.src, "many.csv"), csvText(500));
    const view = await h.assets.register({ projectId: h.projectId, source: p }, human);
    expect(view.metadata?.rowCountExact).toBe(false);
    expect(view.metadata?.truncated).toBe(true);
    const n = view.metadata?.rowCount ?? 0;
    expect(n).toBeGreaterThan(300);
    expect(n).toBeLessThan(700);
  });

  it("jsonl: columns from the first objects, row count, sample rows", async () => {
    h = await dataHarness();
    const p = writeFixture(join(h.src, "events.jsonl"), jsonlText(12));
    const view = await h.assets.register({ projectId: h.projectId, source: p }, human);
    expect(view.format).toBe("jsonl");
    expect(view.metadata?.rowCount).toBe(12);
    expect(view.metadata?.columns).toEqual([
      { name: "id", type: "integer" },
      { name: "tag", type: "string" },
      { name: "score", type: "number" },
      { name: "ok", type: "boolean" },
    ]);
    expect(view.sample?.rows?.[0]).toEqual({ id: 1, tag: "t1", score: 0.5, ok: false });
  });

  it("json: arrays of objects become columns and a count; objects list their keys; big documents report a shape", async () => {
    h = await dataHarness({ jsonParseMaxBytes: 300 });
    const arr = writeFixture(
      join(h.src, "arr.json"),
      JSON.stringify([
        { a: 1, b: "x" },
        { a: 2, b: null },
      ]),
    );
    const av = await h.assets.register({ projectId: h.projectId, source: arr }, human);
    expect(av.format).toBe("json");
    expect(av.metadata?.rowCount).toBe(2);
    expect(av.metadata?.columns).toEqual([
      { name: "a", type: "integer" },
      { name: "b", type: "string" },
    ]);
    expect(av.sample?.kind).toBe("rows");
    const obj = writeFixture(
      join(h.src, "obj.json"),
      JSON.stringify({ name: "x", list: [1, 2], when: "2026-01-01" }),
    );
    const ov = await h.assets.register({ projectId: h.projectId, source: obj }, human);
    expect(ov.metadata?.columns).toEqual([
      { name: "name", type: "string" },
      { name: "list", type: "array" },
      { name: "when", type: "date" },
    ]);
    expect(ov.sample?.kind).toBe("text");
    const big = writeFixture(
      join(h.src, "big.json"),
      JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ i }))),
    );
    const bv = await h.assets.register({ projectId: h.projectId, source: big }, human);
    expect(bv.metadata?.truncated).toBe(true);
    expect(bv.metadata?.columns).toEqual([{ name: "$", type: "array" }]);
    expect(bv.sample?.note).toMatch(/larger than/);
  });

  it("png and jpeg dimensions come from the headers; the extension never overrides magic bytes", async () => {
    h = await dataHarness();
    const png = writeFixture(join(h.src, "img.png"), pngBytes(640, 480));
    const pv = await h.assets.register({ projectId: h.projectId, source: png }, human);
    expect(pv.format).toBe("png");
    expect(pv.mime).toBe("image/png");
    expect(pv.metadata?.dimensions).toEqual({ width: 640, height: 480 });
    expect(pv.sample).toBeNull();
    const jpg = writeFixture(join(h.src, "photo.jpeg"), jpegBytes(1920, 1080));
    const jv = await h.assets.register({ projectId: h.projectId, source: jpg }, human);
    expect(jv.format).toBe("jpeg");
    expect(jv.metadata?.dimensions).toEqual({ width: 1920, height: 1080 });
    const lying = writeFixture(join(h.src, "data.csv"), pngBytes(2, 3));
    const lv = await h.assets.register({ projectId: h.projectId, source: lying }, human);
    expect(lv.format).toBe("png");
    expect(lv.metadata?.columns).toBeNull();
    expect(pngDimensions(new Uint8Array(4))).toBeNull();
    expect(jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(sniffFormat(new TextEncoder().encode("PAR1xxxx"))).toBe("parquet");
    expect(sniffFormat(new TextEncoder().encode("SQLite format 3\0"))).toBe("sqlite");
  });

  it("text encoding: utf-8, utf-8 with BOM, utf-16le, latin1 and binary", async () => {
    h = await dataHarness();
    const bom = writeFixture(
      join(h.src, "bom.txt"),
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("héllo\n")]),
    );
    const bv = await h.assets.register({ projectId: h.projectId, source: bom }, human);
    expect(bv.metadata?.encoding).toBe("utf-8-bom");
    expect(bv.sample?.text).toBe("héllo\n");
    expect(bv.metadata?.lineCount).toBe(1);
    const u16 = writeFixture(join(h.src, "u16.txt"), Buffer.from("\ufeffhi\n", "utf16le"));
    const uv = await h.assets.register({ projectId: h.projectId, source: u16 }, human);
    expect(uv.metadata?.encoding).toBe("utf-16le");
    expect(uv.format).toBe("text");
    const bin = writeFixture(join(h.src, "blob.dat"), new Uint8Array([0, 1, 2, 3, 0, 0, 7]));
    const binv = await h.assets.register({ projectId: h.projectId, source: bin }, human);
    expect(binv.format).toBe("binary");
    expect(binv.metadata?.encoding).toBe("binary");
    expect(binv.mime).toBe("application/octet-stream");
    expect(detectEncoding(new Uint8Array([0xe9, 0x74, 0xe9]))).toBe("latin1");
    expect(detectEncoding(new TextEncoder().encode("plain"))).toBe("utf-8");
  });
});

describe("data assets: samples and removal", () => {
  let h: DataHarness;
  afterEach(async () => {
    await h?.close();
  });

  it("samples are capped: bytes never exceed the hard cap, rows never exceed the max", async () => {
    h = await dataHarness({ sampleBytes: 4096, maxSampleRows: 10, sampleRows: 3 });
    const p = writeFixture(join(h.src, "wide.csv"), csvText(5000));
    expect(statSync(p).size).toBeGreaterThan(100_000);
    const view = await h.assets.register({ projectId: h.projectId, source: p }, human);
    const byDefault = await h.assets.sample(view.id);
    expect(byDefault.kind).toBe("rows");
    expect(byDefault.rows).toHaveLength(3);
    expect(byDefault.truncated).toBe(true);
    const greedy = await h.assets.sample(view.id, { rows: 1_000_000, bytes: 50_000_000 });
    expect(greedy.rows).toHaveLength(10);
    expect(greedy.capBytes).toBe(4096);
    expect(greedy.bytes).toBeLessThanOrEqual(4096);
    const txt = writeFixture(join(h.src, "long.txt"), "x".repeat(20_000));
    const tv = await h.assets.register({ projectId: h.projectId, source: txt }, human);
    const ts = await h.assets.sample(tv.id, { bytes: 1 << 30 });
    expect(ts.kind).toBe("text");
    expect(ts.text?.length).toBe(4096);
    expect(ts.truncated).toBe(true);
    const tiny = await h.assets.sample(tv.id, { bytes: 10 });
    expect(tiny.text).toBe("xxxxxxxxxx");
    const binary = writeFixture(join(h.src, "b.bin"), new Uint8Array(9000));
    const bv = await h.assets.register({ projectId: h.projectId, source: binary }, human);
    const bs = await h.assets.sample(bv.id);
    expect(bs.text).toMatch(/^hex of the first 256 bytes/);
    expect(bs.bytes).toBe(256);
  });

  it("samples of folders list entries; a moved file is reported, not read", async () => {
    h = await dataHarness();
    const root = join(h.src, "f");
    for (let i = 0; i < 8; i++) writeFixture(join(root, `f${i}.txt`), "x");
    const fv = await h.assets.register({ projectId: h.projectId, source: root }, human);
    const fs = await h.assets.sample(fv.id, { rows: 3 });
    expect(fs.kind).toBe("entries");
    expect(fs.entries).toHaveLength(3);
    expect(fs.truncated).toBe(true);
    const p = writeFixture(join(h.src, "gone.txt"), "bye");
    const gv = await h.assets.register({ projectId: h.projectId, source: p }, human);
    const { rmSync } = await import("node:fs");
    rmSync(p);
    expect((await h.assets.get(gv.id)).available).toBe(false);
    await expect(h.assets.sample(gv.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("remove needs a human, deletes only copies under the data dir and audits", async () => {
    h = await dataHarness();
    const p = writeFixture(join(h.src, "keep.csv"), csvText(2));
    const linked = await h.assets.register({ projectId: h.projectId, source: p }, human);
    const copied = await h.assets.register(
      { projectId: h.projectId, source: p, mode: "copy" },
      human,
    );
    await expect(h.assets.remove(linked.id, agent)).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(await h.store.dataAsset.get(linked.id)).toBeDefined();
    const r1 = await h.assets.remove(linked.id, human);
    expect(r1.deletedFromDisk).toBe(false);
    expect(existsSync(p)).toBe(true);
    const r2 = await h.assets.remove(copied.id, human);
    expect(r2.deletedFromDisk).toBe(true);
    expect(existsSync(copied.locator)).toBe(false);
    expect(existsSync(p)).toBe(true);
    expect(await h.store.dataAsset.get(copied.id)).toBeUndefined();
    const project = await h.store.project.mustGet(h.projectId);
    expect(project.data_assets).toEqual([]);
    const audit = await h.store.auditLog.list({ tool: "data.remove" });
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.human_id === "h-1")).toBe(true);
    await expect(h.assets.remove("nope", human)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rows written by the state service's upload route still render as a view", async () => {
    h = await dataHarness();
    const row = await h.store.dataAsset.insert({
      project_ids: [h.projectId],
      locator: join(h.src, "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b-photo.jpg"),
      size_bytes: 10,
      kind: "upload",
      sample: { contentType: "image/jpeg", originalName: "photo.jpg" },
      registered_by: "h-1",
    });
    const view = h.assets.view(row);
    expect(view.name).toBe("photo.jpg");
    expect(view.storage).toBe("linked");
    expect(view.format).toBe("jpeg");
    expect(view.metadata).toBeNull();
    expect(view.sample).toBeNull();
    expect(view.available).toBe(false);
  });
});
