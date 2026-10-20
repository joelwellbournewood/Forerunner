import { readFileSync } from "node:fs";
import { ForerunnerError, log } from "@forerunner/platform";
import { z } from "zod";
import { EMPTY_PERMISSIONS, EXTENSION_PANEL_KINDS, ExtensionPermissions } from "./types.ts";

/**
 * The extension catalog: the built-in list of capabilities this repository ships, generic MCP
 * servers described by command/args or URL, and an optional remote catalog (the same JSON
 * shape, fetched from a URL the human configures). Nothing in it is specific to an org, a
 * host or a user path; secrets appear only as `secret:<name>` references.
 */

const HttpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "only http(s) URLs are supported");

export const StdioTransport = z
  .object({
    type: z.literal("stdio"),
    /** Executable; resolved through PATH, never a shell string. */
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Extra environment; values may be `secret:<name>` references resolved at spawn time. */
    env: z.record(z.string().min(1), z.string()).default({}),
    cwd: z.string().min(1).optional(),
  })
  .strict();
export type StdioTransport = z.infer<typeof StdioTransport>;

export const HttpTransport = z
  .object({
    type: z.literal("http"),
    url: HttpUrl,
    /** Extra headers; values may be `secret:<name>` references resolved at connect time. */
    headers: z.record(z.string().min(1), z.string()).default({}),
  })
  .strict();
export type HttpTransport = z.infer<typeof HttpTransport>;

export const ConnectorTransport = z.discriminatedUnion("type", [StdioTransport, HttpTransport]);
export type ConnectorTransport = z.infer<typeof ConnectorTransport>;

export const CATALOG_ID_RE = /^[a-z][a-z0-9-]*$/;

export const CatalogEntry = z
  .object({
    id: z.string().regex(CATALOG_ID_RE, "catalog ids are lowercase letters, digits and dashes"),
    kind: z.enum(EXTENSION_PANEL_KINDS),
    name: z.string().min(1).max(80),
    description: z.string().min(1),
    version: z.string().default(""),
    homepage: HttpUrl.optional(),
    /** Connectors only: how to reach the MCP server. */
    transport: ConnectorTransport.optional(),
    /** Capabilities, skills, specialists and providers: the module that implements it. */
    module: z.string().min(1).optional(),
    /** Declared permissions. For connectors the live review adds what the server exposes. */
    permissions: ExtensionPermissions.default({ ...EMPTY_PERMISSIONS }),
    /** Minimum autonomy level before the capability may act at all. */
    requiresAutonomy: z.number().int().min(0).max(4).optional(),
    tags: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.kind === "connector" && !e.transport) {
      ctx.addIssue({
        code: "custom",
        path: ["transport"],
        message: "a connector needs a transport",
      });
    }
    if (e.kind !== "connector" && e.transport) {
      ctx.addIssue({
        code: "custom",
        path: ["transport"],
        message: "only connectors have a transport",
      });
    }
  });
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const CatalogFile = z
  .object({ version: z.literal(1), entries: z.array(CatalogEntry) })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [i, e] of file.entries.entries()) {
      if (seen.has(e.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "id"],
          message: `duplicate id ${e.id}`,
        });
      }
      seen.add(e.id);
    }
  });
export type CatalogFile = z.infer<typeof CatalogFile>;

function describeIssues(issues: { path: PropertyKey[]; message: string }[]): string[] {
  return issues.slice(0, 10).map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

/** Validate a catalog document; throws `validation` with the first issues listed. */
export function parseCatalog(json: unknown, source = "catalog"): CatalogFile {
  const parsed = CatalogFile.safeParse(json);
  if (!parsed.success) {
    const issues = describeIssues(parsed.error.issues);
    throw new ForerunnerError("validation", `invalid extension catalog (${source}): ${issues[0]}`, {
      details: { source, issues },
    });
  }
  return parsed.data;
}

/** Validate a single entry (what "add from URL" accepts as a manifest). */
export function parseCatalogEntry(json: unknown, source = "manifest"): CatalogEntry {
  const parsed = CatalogEntry.safeParse(json);
  if (!parsed.success) {
    const issues = describeIssues(parsed.error.issues);
    throw new ForerunnerError("validation", `invalid catalog entry (${source}): ${issues[0]}`, {
      details: { source, issues },
    });
  }
  return parsed.data;
}

/** The catalog shipped with this build (`catalog.json` next to this file). */
export function loadBuiltinCatalog(): CatalogFile {
  const text = readFileSync(new URL("./catalog.json", import.meta.url), "utf8");
  return parseCatalog(JSON.parse(text), "builtin");
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchCatalogOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Upper bound on the document size. */
  maxBytes?: number;
}

/** Fetch a JSON document with a timeout and a size cap; never follows to a non-http scheme. */
export async function fetchJson(url: string, opts: FetchCatalogOptions = {}): Promise<unknown> {
  const parsedUrl = HttpUrl.safeParse(url);
  if (!parsedUrl.success) {
    throw new ForerunnerError("validation", `not an http(s) URL: ${url.slice(0, 120)}`);
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(parsedUrl.data, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new ForerunnerError(
        "unavailable",
        `fetching ${parsedUrl.data} failed: HTTP ${res.status}`,
        {
          details: { status: res.status },
          retryable: res.status >= 500,
        },
      );
    }
    const text = await res.text();
    if (text.length > (opts.maxBytes ?? 1_000_000)) {
      throw new ForerunnerError("validation", "document too large", {
        details: { bytes: text.length },
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ForerunnerError("validation", `${parsedUrl.data} is not JSON`);
    }
  } catch (e) {
    if (e instanceof ForerunnerError) throw e;
    throw new ForerunnerError("unavailable", `fetching ${parsedUrl.data} failed`, {
      cause: e,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCatalog(
  url: string,
  opts: FetchCatalogOptions = {},
): Promise<CatalogFile> {
  return parseCatalog(await fetchJson(url, opts), url);
}

/** Environment variable that names an optional remote catalog. */
export const CATALOG_URL_ENV = "FORERUNNER_EXTENSION_CATALOG_URL";

export function catalogUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[CATALOG_URL_ENV]?.trim();
  return v ? v : null;
}

export interface ExtensionCatalogOptions {
  /** Remote catalog to merge in; its entries never override built-in ids. */
  remoteUrl?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Built-in entries plus the entries of the remote catalog after `refresh()`. Built-in ids win
 * so a remote document cannot replace the shipped description of a capability.
 */
export class ExtensionCatalog {
  private readonly builtin = new Map<string, CatalogEntry>();
  private remote = new Map<string, CatalogEntry>();
  private readonly logger = log("extensions:catalog");

  constructor(
    builtin: CatalogFile = loadBuiltinCatalog(),
    private readonly opts: ExtensionCatalogOptions = {},
  ) {
    for (const e of builtin.entries) this.builtin.set(e.id, e);
  }

  get remoteUrl(): string | null {
    return this.opts.remoteUrl ?? null;
  }

  entries(): CatalogEntry[] {
    const out = [...this.builtin.values()];
    for (const [id, e] of this.remote) if (!this.builtin.has(id)) out.push(e);
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): CatalogEntry | undefined {
    return this.builtin.get(id) ?? this.remote.get(id);
  }

  mustGet(id: string): CatalogEntry {
    const e = this.get(id);
    if (!e) {
      throw new ForerunnerError("not_found", `catalog entry ${id} not found`, {
        details: { catalogId: id },
      });
    }
    return e;
  }

  /** Reload the remote catalog. Failures are logged and leave the previous remote set. */
  async refresh(): Promise<{ remote: number; skipped: string[] }> {
    const url = this.opts.remoteUrl;
    if (!url) return { remote: 0, skipped: [] };
    const file = await fetchCatalog(url, {
      fetch: this.opts.fetch,
      timeoutMs: this.opts.timeoutMs,
    });
    const next = new Map<string, CatalogEntry>();
    const skipped: string[] = [];
    for (const e of file.entries) {
      if (this.builtin.has(e.id)) skipped.push(e.id);
      else next.set(e.id, e);
    }
    this.remote = next;
    this.logger.info("remote catalog loaded", { url, entries: next.size, skipped });
    return { remote: next.size, skipped };
  }
}
