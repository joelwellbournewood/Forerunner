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

const ProviderNames = z.array(z.string().min(1)).min(1);

/**
 * Voice capabilities only (spec O.4): the provider names, as registered in the voice
 * registry, the entry stands for on each side, in order of preference. Enabling the row in
 * the Extensions panel makes the first registered one the preferred provider.
 */
export const VoiceCatalogProviders = z
  .object({ stt: ProviderNames.optional(), tts: ProviderNames.optional() })
  .strict()
  .refine((v) => v.stt !== undefined || v.tts !== undefined, {
    message: "a voice entry names an STT or a TTS provider",
  });
export type VoiceCatalogProviders = z.infer<typeof VoiceCatalogProviders>;

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
    /** Voice capabilities: the providers the entry stands for (chosen by enabling the row). */
    voice: VoiceCatalogProviders.optional(),
    tags: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.voice && e.kind !== "capability") {
      ctx.addIssue({
        code: "custom",
        path: ["voice"],
        message: "only a capability stands for voice providers",
      });
    }
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

/**
 * Built-in entries that were taken out of the catalog because another screen owns what they
 * stood for, each with the reason a person reads (U-023: one place for each thing). They can
 * no longer be added (`mustGet` refuses them with the reason, and a remote catalog cannot bring
 * them back), and a row an earlier version installed is retired at the next start
 * (`ExtensionRegistry.retireEntries`).
 */
export const RETIRED_CATALOG_ENTRIES: Readonly<Record<string, string>> = {
  "voice-local":
    "local voice is installed and chosen in Settings → Voice, which also shows the voice providers in force",
  anthropic:
    "the model provider and its key or subscription token are set in Settings (setup); nothing read this row",
  // U-075: the row's tools were the email tools, so switching it off gated email off behind the
  // Email page's back, and the secret it named (agent_mailbox_password) was read by nothing.
  email:
    "email is set on the Email page (Settings → Capabilities → Email): your agent's mailbox, its mode and its limits",
};

/** The reason a retired catalog id gives, or null for any other id. */
export function retiredReason(catalogId: string): string | null {
  return Object.hasOwn(RETIRED_CATALOG_ENTRIES, catalogId)
    ? (RETIRED_CATALOG_ENTRIES[catalogId] ?? null)
    : null;
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

/**
 * Fetch a JSON document with a timeout and a size cap. The body is read through a reader
 * with a running byte count and the request is aborted as soon as the cap is passed (a
 * `content-length` above the cap is refused before any byte is read), so a hostile document
 * never buffers past `maxBytes`. Only http(s) URLs; redirects are followed by the platform
 * fetch. The URL is one the human typed or configured, so private and loopback addresses are
 * allowed on purpose (see extensions.md, "Known issues").
 */
export async function fetchJson(url: string, opts: FetchCatalogOptions = {}): Promise<unknown> {
  const parsedUrl = HttpUrl.safeParse(url);
  if (!parsedUrl.success) {
    throw new ForerunnerError("validation", `not an http(s) URL: ${url.slice(0, 120)}`);
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  const tooLarge = (bytes: number) =>
    new ForerunnerError("validation", "document too large", { details: { bytes, maxBytes } });
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
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      throw tooLarge(declared);
    }
    const text = await readBounded(res, maxBytes, () => controller.abort(), tooLarge);
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

/** Read a response body chunk by chunk; abort and throw once more than `maxBytes` arrived. */
async function readBounded(
  res: Response,
  maxBytes: number,
  abort: () => void,
  tooLarge: (bytes: number) => Error,
): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooLarge(Buffer.byteLength(text));
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      abort();
      await reader.cancel().catch(() => undefined);
      throw tooLarge(total);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
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

  /**
   * True for an entry shipped with this build (authored in the repository). Only such entries
   * may be started for discovery before the human has said yes; remote catalog entries and
   * manifests from a URL are not trusted that far (ADR 0016).
   */
  isBuiltin(id: string): boolean {
    return this.builtin.has(id);
  }

  mustGet(id: string): CatalogEntry {
    const retired = retiredReason(id);
    if (retired) {
      throw new ForerunnerError("validation", `${id} is no longer an extension: ${retired}`, {
        details: { catalogId: id, retired: true },
      });
    }
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
      if (this.builtin.has(e.id) || retiredReason(e.id)) skipped.push(e.id);
      else next.set(e.id, e);
    }
    this.remote = next;
    this.logger.info("remote catalog loaded", { url, entries: next.size, skipped });
    return { remote: next.size, skipped };
  }
}
