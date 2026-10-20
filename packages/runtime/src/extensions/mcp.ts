import type { ChildProcess } from "node:child_process";
import {
  errorMessage,
  ForerunnerError,
  isAbsolute,
  killTree,
  log,
  spawnProcess,
} from "@forerunner/platform";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolExecutionContext, ToolResult, ToolSpec } from "../agent/tools.ts";
import type { ActionClass } from "../enforcement/autonomy.ts";
import { hostnameOf } from "../enforcement/hooks.ts";
import type { SecretsPort } from "../enforcement/ports.ts";
import type { ConnectorTransport, StdioTransport } from "./catalog.ts";
import {
  BRIDGED_TOOL_NAME_RE,
  type ExtensionPermissions,
  maxRisk,
  normalizePermissions,
  type PermissionReview,
  type ReviewedResource,
  type ReviewedTool,
  type Risk,
  riskOf,
  uniq,
} from "./types.ts";

/**
 * MCP connector: one client connection to an MCP server (stdio with argv arrays through the
 * platform shell, streamable HTTP, or any transport a factory supplies, e.g. InMemoryTransport
 * in tests). It lists the server's tools and resources, builds the PermissionReview the human
 * approves, and bridges the tools into Forerunner ToolSpecs (ADR 0016). Secret references in
 * the transport's env or headers are resolved only here, at spawn time, through the
 * SecretsPort, and only for the names the human granted; values never reach the review, the
 * rows, the model context or the logs.
 */

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface TransportMeta {
  extensionId: string;
  name: string;
}

/** A transport that owns a child process (stdio servers): the kill switch registers it. */
export interface ProcessTransport extends Transport {
  readonly child: ChildProcess | null;
}

export function isProcessTransport(t: Transport): t is ProcessTransport {
  return "child" in t;
}

/** Builds the transport from a spec whose secret references are already resolved. */
export type TransportFactory = (
  spec: ConnectorTransport,
  meta: TransportMeta,
) => Transport | Promise<Transport>;

export interface McpConnectOptions {
  extensionId: string;
  name: string;
  transport: ConnectorTransport;
  secrets: SecretsPort;
  /** Secret names that may be resolved for this connection (the approved grant). */
  grantedSecrets: ReadonlySet<string>;
  transportFactory?: TransportFactory;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface BridgedToolSpec extends ToolSpec<Record<string, unknown>> {
  extensionId: string;
  extensionName: string;
  /** The tool's name on the MCP server. */
  mcpTool: string;
}

export function isBridgedTool(t: ToolSpec): t is BridgedToolSpec {
  return typeof (t as Partial<BridgedToolSpec>).extensionId === "string";
}

const SECRET_REF_RE = /^secret:([a-z][a-z0-9_.:-]{0,127})$/;

/** Secret names referenced (never values) by a transport's env or headers. */
export function secretRefsOf(transport: ConnectorTransport): string[] {
  const values =
    transport.type === "stdio" ? Object.values(transport.env) : Object.values(transport.headers);
  const names: string[] = [];
  for (const v of values) {
    const m = SECRET_REF_RE.exec(v);
    if (m?.[1]) names.push(m[1]);
  }
  return uniq(names);
}

/**
 * The same transport with every `secret:<name>` entry left out: what discovery before the
 * human's yes may start. Nothing is resolved; the names stay in the review only.
 */
export function withoutSecretRefs(transport: ConnectorTransport): ConnectorTransport {
  const strip = (o: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => !SECRET_REF_RE.test(v)));
  if (transport.type === "stdio") return { ...transport, env: strip(transport.env) };
  return { ...transport, headers: strip(transport.headers) };
}

/** Hosts a transport reaches by itself (the HTTP endpoint). */
export function transportDomains(transport: ConnectorTransport): string[] {
  if (transport.type !== "http") return [];
  const host = hostnameOf(transport.url);
  return host ? [host] : [];
}

/** Absolute paths handed to a stdio server as arguments (e.g. the filesystem server's roots). */
export function transportPaths(transport: ConnectorTransport): string[] {
  if (transport.type !== "stdio") return [];
  return uniq(transport.args.filter((a) => isAbsolute(a)));
}

/** One line naming what starting the transport does; shown in the review, never a secret value. */
export function describeTransport(transport: ConnectorTransport): string {
  if (transport.type === "stdio") return `runs ${[transport.command, ...transport.args].join(" ")}`;
  return `connects to ${transport.url}`;
}

export function safeToolName(name: string): string {
  let out = name.replace(/[^A-Za-z0-9_.-]+/g, "_");
  if (!/^[A-Za-z]/.test(out)) out = `t_${out}`;
  return out;
}

/** `<extension>.`: every tool an extension contributes carries its own sanitised name. */
export function toolPrefixOf(extensionName: string): string {
  return `${safeToolName(extensionName)}.`;
}

export function ownsToolName(extensionName: string, toolName: string): boolean {
  const prefix = toolPrefixOf(extensionName);
  return toolName.startsWith(prefix) && toolName.length > prefix.length;
}

/** `<extension>.<tool>`: the name tokens and the ToolRegistry use. */
export function bridgedToolName(extensionName: string, toolName: string): string {
  const name = `${toolPrefixOf(extensionName)}${safeToolName(toolName)}`;
  if (!BRIDGED_TOOL_NAME_RE.test(name)) {
    throw new ForerunnerError("validation", `cannot bridge tool name ${toolName}`);
  }
  return name;
}

const PATTERNS: { cls: ActionClass; re: RegExp }[] = [
  {
    cls: "financial",
    re: /^(pay|payment|purchase|buy|checkout|charge|refund|transfer|invoice|billing|order)$/,
  },
  {
    cls: "credential",
    re: /^(password|passwords|credential|credentials|login|signin|authenticate)$/,
  },
  {
    cls: "destructive",
    re: /^(delete|remove|drop|destroy|purge|wipe|truncate|reset|revoke|uninstall|rm|rmdir|kill)$/,
  },
  { cls: "deploy_production", re: /^(deploy|release|rollout)$/ },
  { cls: "merge_pr", re: /^(merge)$/ },
  {
    cls: "external_send",
    re: /^(send|post|publish|email|mail|notify|tweet|message|reply|comment|broadcast|submit|upload|share|invite)$/,
  },
  { cls: "non_routine", re: /^(execute|exec|run|shell|command|spawn|eval|bash|sh|script)$/ },
  {
    cls: "routine_reversible",
    re: /^(create|write|update|edit|add|set|put|patch|insert|rename|move|copy|save|append|mkdir|touch|push|commit|branch|checkout|tag|label|assign|open|close|start|stop|pause|resume)$/,
  },
  {
    cls: "read",
    re: /^(get|list|read|search|fetch|query|describe|find|show|lookup|view|browse|cat|ls|head|tail|stat|status|info|count|check|resolve|render|diff|log|history|summarize|download|preview|inspect|peek|grep|glob|exists|validate|parse|convert|translate|compute|calculate)$/,
  },
];

/** Severity order of the classes: an annotation may only move a class up this list. */
export const CLASS_RANK: Record<ActionClass, number> = {
  read: 0,
  routine_reversible: 1,
  non_routine: 2,
  merge_pr: 3,
  deploy_staging: 4,
  deploy_production: 5,
  external_send: 6,
  destructive: 7,
  financial: 8,
  credential: 9,
  permission_change: 10,
  capability_grant: 11,
};

export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** The class the verbs in the tool name imply, or null when no verb is recognised. */
export function classFromName(name: string): { cls: ActionClass; verb: string } | null {
  const words = nameWords(name);
  for (const { cls, re } of PATTERNS) {
    const hit = words.find((w) => re.test(w));
    if (hit) return { cls, verb: hit };
  }
  return null;
}

/**
 * Action class of an MCP tool (ADR 0016). The verbs in the tool name decide first, from the
 * most severe class down. Server annotations can only tighten the result: `destructiveHint`
 * raises the class to `destructive`; `readOnlyHint` confirms `read` when the name says read
 * or nothing, and is recorded as a conflict (class kept, review flagged) when the name says
 * otherwise. No match and no annotation → `non_routine` (asks below autonomy 3). The human
 * can narrow any class in the review before approving; a server can never loosen one.
 */
export function inferActionClass(tool: Pick<McpToolInfo, "name" | "annotations">): {
  actionClass: ActionClass;
  inferredFrom: string;
} {
  const byName = classFromName(tool.name);
  const a = tool.annotations;
  if (a.destructiveHint === true && (!byName || CLASS_RANK[byName.cls] < CLASS_RANK.destructive)) {
    return {
      actionClass: "destructive",
      inferredFrom: byName
        ? `annotation:destructiveHint,name:${byName.verb}`
        : "annotation:destructiveHint",
    };
  }
  if (a.readOnlyHint === true) {
    if (!byName) return { actionClass: "read", inferredFrom: "annotation:readOnlyHint" };
    if (byName.cls === "read") {
      return { actionClass: "read", inferredFrom: `name:${byName.verb},annotation:readOnlyHint` };
    }
    return { actionClass: byName.cls, inferredFrom: `conflict:readOnlyHint,name:${byName.verb}` };
  }
  if (byName) return { actionClass: byName.cls, inferredFrom: `name:${byName.verb}` };
  return { actionClass: "non_routine", inferredFrom: "default" };
}

const PATH_FIELD_RE =
  /^(path|paths|file|files|filename|filepath|file_path|dir|directory|folder|cwd|root|dest|destination|source|src|target|location)$|(_path|_paths|_dir|_file|_files|_folder|Path|Paths|Dir|File|Files|Folder)$/;
const DOMAIN_FIELD_RE =
  /^(url|urls|uri|uris|href|link|links|endpoint|host|hostname|domain|origin|base_url|baseUrl|website|site|server)$|(_url|_urls|_uri|_host|_domain|Url|Urls|Uri|Host|Domain)$/;

/** Input fields that carry paths or URLs, from the JSON schema's top-level property names. */
export function inferFields(inputSchema: Record<string, unknown>): {
  pathFields: string[];
  domainFields: string[];
} {
  const props = asRecord(inputSchema.properties);
  const pathFields: string[] = [];
  const domainFields: string[] = [];
  for (const [key, raw] of Object.entries(props)) {
    const def = asRecord(raw);
    const type = def.type;
    const stringish =
      type === undefined ||
      type === "string" ||
      (Array.isArray(type) && type.includes("string")) ||
      (type === "array" && (asRecord(def.items).type ?? "string") === "string");
    if (!stringish) continue;
    if (PATH_FIELD_RE.test(key)) pathFields.push(key);
    else if (DOMAIN_FIELD_RE.test(key)) domainFields.push(key);
  }
  return { pathFields: pathFields.sort(), domainFields: domainFields.sort() };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * A loose zod schema from the server's JSON schema: top-level property types and required
 * keys are checked here (so the hooks can reject malformed calls and find path/domain
 * fields); the server validates the rest.
 */
export function zodFromJsonSchema(
  schema: Record<string, unknown>,
): z.ZodType<Record<string, unknown>> {
  const props = asRecord(schema.properties);
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : [],
  );
  const shape: Record<string, z.ZodType> = {};
  for (const [key, raw] of Object.entries(props)) {
    const def = asRecord(raw);
    let t: z.ZodType;
    const type = Array.isArray(def.type) ? def.type[0] : def.type;
    switch (type) {
      case "string":
        t = z.string();
        break;
      case "number":
        t = z.number();
        break;
      case "integer":
        t = z.number().int();
        break;
      case "boolean":
        t = z.boolean();
        break;
      case "array":
        t = z.array(z.unknown());
        break;
      case "object":
        t = z.looseObject({});
        break;
      default:
        t = z.unknown();
    }
    shape[key] = required.has(key) ? t : t.optional();
  }
  return z.looseObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
}

export interface BuildReviewInput {
  extensionName: string;
  transport: ConnectorTransport | null;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  /** Declared by the catalog entry or the human; merged into the review. */
  declared?: Partial<ExtensionPermissions>;
  /** Extra lines for the approval card (e.g. why discovery has not run yet). */
  notes?: string[];
}

/**
 * Bridged names for a server's tools, in a deterministic order (by server name). Two server
 * tools whose sanitised names collide (`read file` and `read_file`) get `_2`, `_3` suffixes
 * so one approved name never stands for two server tools.
 */
export function assignBridgedNames(
  extensionName: string,
  tools: readonly Pick<McpToolInfo, "name">[],
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  // code-point order, not locale order, so every machine assigns the same names
  for (const t of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (out.has(t.name)) continue;
    const base = bridgedToolName(extensionName, t.name);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    out.set(t.name, name);
  }
  return out;
}

/** The review the human sees: every tool with class and risk, resources, domains, secrets. */
export function buildReview(input: BuildReviewInput): PermissionReview {
  const names = assignBridgedNames(input.extensionName, input.tools);
  const tools: ReviewedTool[] = input.tools
    .map((t) => {
      const { actionClass, inferredFrom } = inferActionClass(t);
      const fields = inferFields(t.inputSchema);
      return {
        name: t.name,
        bridgedName: names.get(t.name) ?? bridgedToolName(input.extensionName, t.name),
        description: t.description,
        actionClass,
        risk: riskOf(actionClass),
        pathFields: fields.pathFields,
        domainFields: fields.domainFields,
        inferredFrom,
      };
    })
    .sort((a, b) => a.bridgedName.localeCompare(b.bridgedName));
  const resources: ReviewedResource[] = input.resources
    .map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType }))
    .sort((a, b) => a.uri.localeCompare(b.uri));
  const declared = input.declared ?? {};
  const permissions = normalizePermissions({
    tools: [...(declared.tools ?? []), ...tools.map((t) => t.bridgedName)],
    actionClasses: [...(declared.actionClasses ?? []), ...tools.map((t) => t.actionClass)],
    domains: [
      ...(declared.domains ?? []),
      ...(input.transport ? transportDomains(input.transport) : []),
    ],
    paths: [...(declared.paths ?? []), ...(input.transport ? transportPaths(input.transport) : [])],
    secrets: [
      ...(declared.secrets ?? []),
      ...(input.transport ? secretRefsOf(input.transport) : []),
    ],
    scopes: declared.scopes ?? [],
  });
  const risks: Risk[] = tools.map((t) => t.risk);
  if (permissions.secrets.length) risks.push("medium");
  if (permissions.actionClasses.some((c) => riskOf(c) === "high")) risks.push("high");
  const summary: string[] = [];
  for (const t of tools) {
    summary.push(`tool ${t.bridgedName}: ${t.actionClass} (${t.risk} risk)`);
    if (t.inferredFrom.startsWith("conflict:")) {
      summary.push(
        `tool ${t.bridgedName}: the server calls it read-only but its name says ${t.inferredFrom.slice("conflict:readOnlyHint,name:".length)}; kept ${t.actionClass}`,
      );
    }
    if (t.bridgedName !== bridgedToolName(input.extensionName, t.name)) {
      summary.push(`tool ${t.bridgedName}: server tool "${t.name}" (name collision, renamed)`);
    }
  }
  for (const r of resources) summary.push(`reads resource ${r.uri}`);
  for (const d of permissions.domains) summary.push(`reaches ${d}`);
  for (const p of permissions.paths) summary.push(`touches ${p}`);
  for (const s of permissions.secrets) summary.push(`uses secret:${s} (value never shown)`);
  for (const s of permissions.scopes) summary.push(`scope: ${s}`);
  if (input.transport) summary.push(describeTransport(input.transport));
  for (const n of input.notes ?? []) summary.push(n);
  return { tools, resources, permissions, risk: maxRisk(risks), summary };
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;
const CLOSE_GRACE_MS = 2_000;
const CLOSE_WAIT_MS = 5_000;

/**
 * Stdio transport over the platform shell: argv arrays, no shell string, the child process
 * exposed so the registry can register it with the kill switch (`killTree` on stop). Messages
 * are newline-delimited JSON-RPC, read with the SDK's buffer. stderr is drained and dropped.
 */
export class StdioMcpTransport implements ProcessTransport {
  private proc: ChildProcess | null = null;
  private readonly buffer = new ReadBuffer();
  private started = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly spec: StdioTransport) {}

  get child(): ChildProcess | null {
    return this.proc;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("StdioMcpTransport already started");
    this.started = true;
    const child = spawnProcess([this.spec.command, ...this.spec.args], {
      cwd: this.spec.cwd,
      env: { ...getDefaultEnvironment(), ...this.spec.env },
    });
    this.proc = child;
    child.on("error", (e) => this.onerror?.(e));
    child.on("close", () => {
      this.proc = null;
      this.onclose?.();
    });
    child.stdin?.on("error", (e) => this.onerror?.(e));
    child.stderr?.resume();
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (;;) {
          const message = this.buffer.readMessage();
          if (!message) break;
          this.onmessage?.(message);
        }
      } catch (e) {
        this.onerror?.(e instanceof Error ? e : new Error(String(e)));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (e: Error) => {
        child.off("spawn", onSpawn);
        reject(e);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) throw new Error("MCP server process is not running");
    if (!stdin.write(serializeMessage(message))) {
      await new Promise<void>((r) => stdin.once("drain", r));
    }
  }

  /** End stdin, give the server a moment to exit, then kill its process tree. */
  async close(): Promise<void> {
    const child = this.proc;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.proc = null;
      return;
    }
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    try {
      child.stdin?.end();
    } catch {
      // stdin already gone
    }
    const grace = setTimeout(() => killTree(child), CLOSE_GRACE_MS);
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, CLOSE_WAIT_MS).unref?.())]);
    clearTimeout(grace);
    if (child.exitCode === null && child.signalCode === null) killTree(child);
  }
}

/** Builds stdio or streamable-HTTP transports; env/headers must already be resolved. */
export const defaultTransportFactory: TransportFactory = (spec) => {
  if (spec.type === "stdio") return new StdioMcpTransport(spec);
  return new StreamableHTTPClientTransport(new URL(spec.url), {
    requestInit: { headers: { ...spec.headers } },
  });
};

export class McpConnector {
  private readonly logger = log("extensions:mcp");
  private isClosed = false;
  readonly extensionId: string;
  readonly name: string;

  private constructor(
    private readonly client: Client,
    private readonly transport: Transport,
    private readonly opts: McpConnectOptions,
  ) {
    this.extensionId = opts.extensionId;
    this.name = opts.name;
    transport.onclose = () => {
      this.isClosed = true;
    };
    transport.onerror = (e) => {
      this.logger.warn("transport error", { extension: this.name, error: errorMessage(e) });
    };
  }

  /**
   * Resolve secret references (granted names only), build the transport and initialise.
   * Secret values live in the transport only; the spec kept by the registry keeps the refs.
   */
  static async connect(opts: McpConnectOptions): Promise<McpConnector> {
    const resolved = await resolveTransportSecrets(
      opts.transport,
      opts.secrets,
      opts.grantedSecrets,
    );
    const factory = opts.transportFactory ?? defaultTransportFactory;
    const transport = await factory(resolved, { extensionId: opts.extensionId, name: opts.name });
    const client = new Client({ name: "forerunner", version: "1.0.0" });
    try {
      await client.connect(transport, {
        timeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      });
    } catch (e) {
      try {
        await transport.close();
      } catch {
        // already gone
      }
      throw new ForerunnerError("unavailable", `MCP server ${opts.name} did not connect`, {
        details: { extensionId: opts.extensionId, error: opts.secrets.redact(errorMessage(e)) },
        retryable: true,
        cause: e,
      });
    }
    log("extensions:mcp").info("connected", {
      extension: opts.name,
      transport: opts.transport.type,
      secrets: [...opts.grantedSecrets],
    });
    return new McpConnector(client, transport, opts);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** The server's child process when the transport spawned one (stdio), else null. */
  get child(): ChildProcess | null {
    return isProcessTransport(this.transport) ? this.transport.child : null;
  }

  async listTools(): Promise<McpToolInfo[]> {
    this.assertOpen();
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined, {
        timeout: this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      });
      for (const t of page.tools) {
        out.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: asRecord(t.inputSchema),
          annotations: { ...(t.annotations ?? {}) },
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async listResources(): Promise<McpResourceInfo[]> {
    this.assertOpen();
    const caps = this.client.getServerCapabilities();
    if (!caps?.resources) return [];
    const out: McpResourceInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listResources(cursor ? { cursor } : undefined, {
        timeout: this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      });
      for (const r of page.resources) {
        out.push({
          uri: r.uri,
          name: r.name,
          description: r.description ?? "",
          mimeType: r.mimeType ?? "",
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  /**
   * List tools and resources and build the review the human approves. `transport` lets a
   * secret-free discovery connection describe the real transport (with its secret names).
   */
  async review(
    declared?: Partial<ExtensionPermissions>,
    opts: { transport?: ConnectorTransport; notes?: string[] } = {},
  ): Promise<PermissionReview> {
    const [tools, resources] = await Promise.all([this.listTools(), this.listResources()]);
    for (const t of tools) this.schemas.set(t.name, t.inputSchema);
    return buildReview({
      extensionName: this.name,
      transport: opts.transport ?? this.opts.transport,
      tools,
      resources,
      declared,
      notes: opts.notes,
    });
  }

  /**
   * Call a tool on the server. Output is text (non-text blocks are summarised), redacted
   * through the SecretsPort and marked untrusted for the hooks.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    this.assertOpen();
    const res = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      signal,
    });
    const blocks = Array.isArray(res.content) ? (res.content as Record<string, unknown>[]) : [];
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "image") parts.push(`[image ${String(b.mimeType ?? "")}]`);
      else if (b.type === "audio") parts.push(`[audio ${String(b.mimeType ?? "")}]`);
      else if (b.type === "resource")
        parts.push(`[resource ${String(asRecord(b.resource).uri ?? "")}]`);
      else if (b.type === "resource_link") parts.push(`[resource_link ${String(b.uri ?? "")}]`);
      else parts.push(`[${String(b.type ?? "block")}]`);
    }
    if (res.structuredContent !== undefined) {
      parts.push(JSON.stringify(res.structuredContent));
    }
    let content = parts.join("\n");
    if (content.length > MAX_OUTPUT_CHARS)
      content = `${content.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]`;
    return {
      content: this.opts.secrets.redact(content),
      isError: res.isError === true,
      untrusted: { source: "tool_output", origin: `mcp:${this.name}` },
    };
  }

  /**
   * ToolSpecs for the tools the review (as approved) lists: those in `allowed` (when given)
   * whose class is in `classes` (when non-empty). Each carries the extension id, the class
   * and the path/domain fields from the review, and executes through this connection; once
   * the connection is closed every call is refused in code.
   */
  bridgeTools(
    review: PermissionReview,
    allowed?: readonly string[],
    classes?: readonly ActionClass[],
  ): BridgedToolSpec[] {
    const allowSet = allowed ? new Set(allowed) : null;
    const classSet = classes?.length ? new Set(classes) : null;
    const specs: BridgedToolSpec[] = [];
    for (const t of review.tools) {
      if (allowSet && !allowSet.has(t.bridgedName)) continue;
      if (classSet && !classSet.has(t.actionClass)) continue;
      specs.push(this.bridge(t));
    }
    return specs;
  }

  private bridge(t: ReviewedTool): BridgedToolSpec {
    const schemaSource = this.schemas.get(t.name) ?? {};
    const self = this;
    return {
      name: t.bridgedName,
      description: t.description
        ? `${t.description} (via ${this.name})`
        : `${t.name} via ${this.name}`,
      schema: zodFromJsonSchema(schemaSource),
      actionClass: t.actionClass,
      risk: t.risk,
      pathFields: [...t.pathFields],
      domainFields: [...t.domainFields],
      timeoutMs: this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      extensionId: this.extensionId,
      extensionName: this.name,
      mcpTool: t.name,
      async execute(
        input: Record<string, unknown>,
        ctx: ToolExecutionContext,
      ): Promise<ToolResult> {
        return self.callTool(t.name, input, ctx.signal);
      },
    };
  }

  private readonly schemas = new Map<string, Record<string, unknown>>();

  /** Remember input schemas so bridged tools validate the top level (review() does this too). */
  async rememberSchemas(): Promise<void> {
    for (const t of await this.listTools()) this.schemas.set(t.name, t.inputSchema);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      await this.client.close();
    } catch (e) {
      this.logger.debug("close failed", { extension: this.name, error: errorMessage(e) });
    }
    this.logger.info("closed", { extension: this.name });
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new ForerunnerError("tool_not_allowed", `connection to ${this.name} is closed`, {
        details: { extensionId: this.extensionId },
      });
    }
  }
}

/** Resolve `secret:<name>` values in env or headers; names outside `granted` throw. */
export async function resolveTransportSecrets(
  transport: ConnectorTransport,
  secrets: SecretsPort,
  granted: ReadonlySet<string>,
): Promise<ConnectorTransport> {
  if (transport.type === "stdio") {
    const env = (await secrets.resolve(transport.env, granted)) as Record<string, string>;
    return { ...transport, env };
  }
  const headers = (await secrets.resolve(transport.headers, granted)) as Record<string, string>;
  return { ...transport, headers };
}

export interface McpConnectorFactory {
  connect(opts: McpConnectOptions): Promise<McpConnector>;
}

export class DefaultMcpConnectorFactory implements McpConnectorFactory {
  constructor(
    private readonly defaults: {
      transportFactory?: TransportFactory;
      connectTimeoutMs?: number;
      callTimeoutMs?: number;
    } = {},
  ) {}

  async connect(opts: McpConnectOptions): Promise<McpConnector> {
    const c = await McpConnector.connect({ ...this.defaults, ...opts });
    await c.rememberSchemas();
    return c;
  }
}
