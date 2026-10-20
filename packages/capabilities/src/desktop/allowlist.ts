/**
 * The per-human application allowlist (spec L: "Per-app allowlist"). An entry names an
 * application by executable (`exe`), by window class (`windowClass`) or by either (`app`); a
 * plain string is shorthand: `"code"` matches executable or class, `"exe:code"` the executable
 * only, `"class:Navigator.firefox"` the class only. Matching is case-insensitive on the
 * executable's base name without `.exe`, and on the X11 `instance.Class` pair (either half or
 * the whole) or the Win32 class name. Titles are never matched: they are content.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AppDirsOptions, appDirs, dirname, ForerunnerError, join } from "@forerunner/platform";
import { z } from "zod";
import type { WindowInfo } from "./types.ts";

export interface DesktopAllowEntry {
  /** Matches the executable or the window class. */
  app?: string;
  /** Executable base name, e.g. `code`, `firefox`, `notepad`. */
  exe?: string;
  /** X11 WM_CLASS (`instance.Class`, either half or the whole) or Win32 class name. */
  windowClass?: string;
  note?: string;
}

export type DesktopAllowlist = readonly (string | DesktopAllowEntry)[];

const name = z.string().trim().min(1).max(128);

export const AllowEntrySchema = z
  .object({
    app: name.optional(),
    exe: name.optional(),
    windowClass: name.optional(),
    note: z.string().max(200).optional(),
  })
  .strict()
  .refine((e) => e.app !== undefined || e.exe !== undefined || e.windowClass !== undefined, {
    message: "an allowlist entry needs app, exe or windowClass",
  });

export const AllowlistSchema = z.array(z.union([name, AllowEntrySchema])).max(200);

/** Base name without directory or `.exe`, lower case. */
export function normalizeExe(value: string): string {
  const base = value.trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.exe$/i, "").toLowerCase();
}

export function normalizeClass(value: string): string {
  return value.trim().toLowerCase();
}

export function parseAllowEntry(entry: string | DesktopAllowEntry): DesktopAllowEntry {
  if (typeof entry !== "string") {
    const out: DesktopAllowEntry = {};
    if (entry.app) out.app = entry.app.trim().toLowerCase();
    if (entry.exe) out.exe = normalizeExe(entry.exe);
    if (entry.windowClass) out.windowClass = normalizeClass(entry.windowClass);
    if (entry.note) out.note = entry.note;
    if (!out.app && !out.exe && !out.windowClass) {
      throw new ForerunnerError("validation", "an allowlist entry needs app, exe or windowClass");
    }
    return out;
  }
  const s = entry.trim();
  if (!s) throw new ForerunnerError("validation", "an allowlist entry cannot be empty");
  const m = /^(exe|class):(.+)$/i.exec(s);
  if (m?.[1] && m[2]) {
    return m[1].toLowerCase() === "exe"
      ? { exe: normalizeExe(m[2]) }
      : { windowClass: normalizeClass(m[2]) };
  }
  return { app: s.toLowerCase() };
}

export function normalizeAllowlist(list: DesktopAllowlist): DesktopAllowEntry[] {
  return list.map(parseAllowEntry);
}

function classMatches(windowClass: string, wanted: string): boolean {
  const w = normalizeClass(windowClass);
  if (w === wanted) return true;
  const dot = w.indexOf(".");
  if (dot < 0) return false;
  return w.slice(0, dot) === wanted || w.slice(dot + 1) === wanted;
}

/** True when every field the entry sets matches the window. */
export function windowMatchesEntry(w: WindowInfo, entry: string | DesktopAllowEntry): boolean {
  const e = parseAllowEntry(entry);
  const exe = normalizeExe(w.exe);
  if (e.exe !== undefined && exe !== e.exe) return false;
  if (e.windowClass !== undefined && !classMatches(w.windowClass, e.windowClass)) return false;
  if (e.app !== undefined && exe !== normalizeExe(e.app) && !classMatches(w.windowClass, e.app))
    return false;
  return true;
}

export function windowAllowed(w: WindowInfo, allowlist: DesktopAllowlist): boolean {
  return allowlist.some((entry) => windowMatchesEntry(w, entry));
}

/** `desktop_focus({ app })`: the app names an executable or a class, never a title. */
export function appMatches(w: WindowInfo, app: string): boolean {
  return windowMatchesEntry(w, { app });
}

export function describeEntry(entry: string | DesktopAllowEntry): string {
  const e = parseAllowEntry(entry);
  const parts: string[] = [];
  if (e.app) parts.push(e.app);
  if (e.exe) parts.push(`exe:${e.exe}`);
  if (e.windowClass) parts.push(`class:${e.windowClass}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------------------------
// Stores: the allowlist is settings data the human edits; the orchestrator picks the store.

export interface DesktopAllowlistStore {
  get(humanId: string): Promise<DesktopAllowEntry[]>;
  set(humanId: string, entries: DesktopAllowlist): Promise<DesktopAllowEntry[]>;
}

export class MemoryAllowlistStore implements DesktopAllowlistStore {
  private readonly lists = new Map<string, DesktopAllowEntry[]>();
  constructor(initial: Record<string, DesktopAllowlist> = {}) {
    for (const [humanId, list] of Object.entries(initial))
      this.lists.set(humanId, normalizeAllowlist(list));
  }
  async get(humanId: string): Promise<DesktopAllowEntry[]> {
    return [...(this.lists.get(humanId) ?? [])];
  }
  async set(humanId: string, entries: DesktopAllowlist): Promise<DesktopAllowEntry[]> {
    const normalized = normalizeAllowlist(AllowlistSchema.parse(entries));
    this.lists.set(humanId, normalized);
    return [...normalized];
  }
}

export const DESKTOP_ALLOWLIST_FILE = "desktop-allowlist.json";

/** `<config>/desktop-allowlist.json`: `{ "<humanId>": [entries] }`. No secrets, so plain JSON. */
export class FileAllowlistStore implements DesktopAllowlistStore {
  readonly path: string;
  constructor(opts: { path?: string; appDirs?: AppDirsOptions } = {}) {
    this.path = opts.path ?? join(appDirs(opts.appDirs).config, DESKTOP_ALLOWLIST_FILE);
  }
  private read(): Record<string, DesktopAllowlist> {
    if (!existsSync(this.path)) return {};
    const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ForerunnerError("validation", `${this.path} must hold an object keyed by human id`);
    }
    return raw as Record<string, DesktopAllowlist>;
  }
  async get(humanId: string): Promise<DesktopAllowEntry[]> {
    const list = this.read()[humanId];
    return list ? normalizeAllowlist(AllowlistSchema.parse(list)) : [];
  }
  async set(humanId: string, entries: DesktopAllowlist): Promise<DesktopAllowEntry[]> {
    const normalized = normalizeAllowlist(AllowlistSchema.parse(entries));
    const all = this.read();
    all[humanId] = normalized;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(all, null, 2)}\n`);
    return [...normalized];
  }
}
