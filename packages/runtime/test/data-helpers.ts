import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import AdmZip from "adm-zip";
import { DataAssets } from "../src/data/assets.ts";
import { DataImporter } from "../src/data/import.ts";
import type { DataLimits } from "../src/data/types.ts";

/**
 * One temp directory per test: `src/` holds fixtures the tests register or import, `projects/`
 * is the projects root the service writes under. Nothing touches the developer's data dir.
 */
export interface DataHarness {
  dir: string;
  src: string;
  projectsRoot: string;
  store: StateStore;
  clock: SimulatedClock;
  projectId: string;
  otherProjectId: string;
  assets: DataAssets;
  importer: DataImporter;
  close(): Promise<void>;
}

export async function dataHarness(limits: Partial<DataLimits> = {}): Promise<DataHarness> {
  const dir = mkdtempSync(join(tmpdir(), "fr-data-"));
  const src = join(dir, "src");
  const projectsRoot = join(dir, "projects");
  mkdirSync(src, { recursive: true });
  const clock = new SimulatedClock("2026-03-02T09:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const project = await store.project.insert({ name: "data-project" });
  const other = await store.project.insert({ name: "other-project" });
  const assets = new DataAssets({ store, clock, projectsRoot, limits });
  const importer = new DataImporter({ assets, store, clock });
  return {
    dir,
    src,
    projectsRoot,
    store,
    clock,
    projectId: project.id,
    otherProjectId: other.id,
    assets,
    importer,
    async close() {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function writeFixture(path: string, data: string | Uint8Array): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
}

export function csvText(rows: number, header = "id,name,price,active,when"): string {
  const lines = [header];
  for (let i = 1; i <= rows; i++) {
    lines.push(
      `${i},"item ${i}",${(i * 1.5).toFixed(2)},${i % 2 === 0},2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function jsonlText(rows: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= rows; i++) {
    lines.push(JSON.stringify({ id: i, tag: `t${i}`, score: i / 2, ok: i % 3 === 0 }));
  }
  return `${lines.join("\n")}\n`;
}

/** A valid PNG signature plus an IHDR chunk; enough for the header parser, no pixels. */
export function pngBytes(width: number, height: number): Uint8Array {
  const out = new Uint8Array(8 + 4 + 4 + 13 + 4);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, 13);
  out.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  dv.setUint32(29, 0); // crc not checked
  return out;
}

/** SOI, an APP0 segment, a SOF0 frame header with the size, EOI. */
export function jpegBytes(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

export interface ZipSpec {
  name: string;
  data?: string;
  dir?: boolean;
  symlink?: boolean;
}

/** Build an archive with adm-zip; `symlink` entries carry the unix symlink mode bits. */
export function makeZip(path: string, entries: ZipSpec[]): string {
  const zip = new AdmZip();
  for (const e of entries) {
    if (e.dir) {
      zip.addFile(e.name.endsWith("/") ? e.name : `${e.name}/`, Buffer.alloc(0));
      continue;
    }
    const entry = zip.addFile(e.name, Buffer.from(e.data ?? "", "utf8"));
    // addFile normalises names; write the raw name so hostile archives reach the importer's checks.
    if (entry.entryName !== e.name) entry.entryName = e.name;
    if (e.symlink) entry.attr = (0o120777 << 16) >>> 0;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zip.toBuffer());
  return path;
}

export const human = { humanId: "h-1" };
export const agent = { agentId: "alice", sessionId: "sess-1", runId: "run-1" };
