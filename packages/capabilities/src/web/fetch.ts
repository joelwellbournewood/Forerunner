import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { type Clock, errorMessage, ForerunnerError } from "@forerunner/platform";
import type { AuditPort, ToolExecutionContext, ToolSpec } from "@forerunner/runtime";
import { z } from "zod";
import { extractFromHtml, renderExtract } from "../browser/extract.ts";
import { AI_AGENT_UA_SUFFIX } from "../browser/profile.ts";
import {
  hostOfUrl,
  isPublicAddress,
  privateAddressWords,
  WEB_MAX_URL_CHARS,
  WebReadPolicy,
  type WebReadRules,
} from "./policy.ts";

/**
 * `web_fetch`: one public web page, read with a GET and returned as text (ADR 0107). The loop
 * driver offers it to a registry entry that names `cc:WebFetch` (the researcher and the
 * science-evaluator), so research runs on an API key as it does on a subscription. What it
 * does, in this order:
 *
 * 1. `WebReadPolicy.checkUrl`: http(s) only, no user name or password, at most 2,000
 *    characters, never a local name, the project's rule ("Web pages research may read": any
 *    public website except its "never" list, or "only" its list); an IP literal is judged as an
 *    address at once.
 * 2. A GET over `node:http(s)` whose `lookup` is the policy: every address the host resolves
 *    to must be public, whatever any list says, checked on the addresses the connection then
 *    uses, so a name that resolves to this computer or the local network is refused before any
 *    byte is sent. No cookie, no authorisation header, no body; the user agent says an AI agent
 *    is reading. The connection is direct: on a computer that reaches the internet only through
 *    a proxy (`HTTPS_PROXY` / `HTTP_PROXY`), a failed connection says so (`PROXY_SENTENCE`).
 * 3. Redirects are followed here, hop by hop, each target through the same checks, at most
 *    `WEB_MAX_REDIRECTS`; never by the HTTP client itself.
 * 4. The body is read up to `maxBytes` (default 2 MiB, decompressed) within `timeoutMs`
 *    (default 30 s) and the run's own abort signal; what follows is dropped and said.
 * 5. HTML becomes readable text through the browser's extractor (visible text, hidden text
 *    apart and flagged, links); text, JSON, XML, CSV and markdown pass as they are; anything
 *    else (a PDF, an image) is refused in words.
 *
 * The result is untrusted data (`web_page`, the final URL): the hooks wrap it in the data
 * envelope, scan it for instructions and audit the call. A refusal by the rules is an error
 * result in words for the model, an audit row with `allowed: false` and the reason.
 */
/**
 * The tool's name: the runtime's `WEB_FETCH_TOOL` (`registry/tools.ts`), which maps
 * `cc:WebFetch` to it. Spelled out here, not imported: the runtime imports this package, so a
 * value read from it while the modules load would be undefined (`research-web.test.ts` checks
 * that the two agree).
 */
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export const WEB_MAX_REDIRECTS = 5;
export const DEFAULT_WEB_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_WEB_TIMEOUT_MS = 30_000;
/** The visible text a call returns by default; the model may ask for less or more (up to 60 000). */
export const DEFAULT_WEB_MAX_CHARS = 30_000;

/** How the tool resolves a host name: all addresses, as `dns.lookup(host, { all: true })`. */
export type WebResolve = (host: string) => Promise<LookupAddress[]>;

/**
 * What a failed direct connection adds on a computer with a proxy set ('sites'): the reader does
 * not go through it yet, and search (which runs on Anthropic's side) still works.
 */
export const PROXY_SENTENCE =
  "This computer reaches the internet through a proxy, which Forerunner's page reader does not use yet: pages cannot be read here; web search still works.";

/** Whether this computer names a proxy for its web traffic (`HTTPS_PROXY`, `HTTP_PROXY`, any case). */
export function proxySetIn(env: NodeJS.ProcessEnv): boolean {
  return ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some(
    (k) => (env[k] ?? "").trim() !== "",
  );
}

export interface WebFetchOptions {
  /** The project's rule for the run ("Web pages research may read", `webAccessOf`), read per call. */
  rules: (ctx: ToolExecutionContext) => WebReadRules | Promise<WebReadRules>;
  /**
   * The development seam: this computer's loopback may be read. Only the composition of the
   * scripted development modes (`--provider bench` and `bench-api`) and tests set it.
   */
  loopback?: boolean;
  /** Where the proxy variables are read (default: `process.env`, per call). */
  env?: NodeJS.ProcessEnv;
  audit: AuditPort;
  clock: Clock;
  maxBytes?: number;
  timeoutMs?: number;
  /** Tests: a resolver that maps test hosts to the loopback fixture. Default: the system's. */
  resolve?: WebResolve;
  /** Tests: which addresses count as public. Default: `isPublicAddress`. */
  isPublic?: (address: string) => boolean;
}

/** One page as the tool read it; also what the executor keeps for the critic (`artifacts`). */
export interface WebPageRead {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  truncated: boolean;
}

const TEXT_TYPES =
  /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml|javascript|x-ndjson|csv|yaml|x-yaml|toml)|[^;]*\+(json|xml))/i;

function defaultResolve(host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/** A refusal by the network rules: the code the hooks and the audit name, the words the model reads. */
function refused(message: string, host: string): ForerunnerError {
  return new ForerunnerError("domain_not_allowed", `Refused: ${message}.`, {
    details: { host },
  });
}

interface RawResponse {
  status: number;
  statusText: string;
  location: string | null;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

/**
 * One GET with redirects off. `lookup` is the policy: net calls it for every host name it
 * connects to, and an error from it ends the request before anything is written.
 */
function getOnce(
  url: URL,
  opts: {
    policy: WebReadPolicy;
    host: string;
    resolve: WebResolve;
    isPublic: (address: string) => boolean;
    signal: AbortSignal;
    maxBytes: number;
  },
): Promise<RawResponse> {
  const { policy, host, resolve, isPublic, signal, maxBytes } = opts;
  const lookup = (
    hostname: string,
    options: { all?: boolean } | number,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    resolve(hostname).then(
      (addresses) => {
        if (!addresses.length) {
          callback(
            Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" }),
            "",
          );
          return;
        }
        const bad = addresses.find((a) => !policy.addressAllowed(host, a.address, isPublic));
        if (bad) {
          callback(refused(privateAddressWords(host, bad.address), host) as never, "");
          return;
        }
        const all = typeof options === "object" && options.all === true;
        if (all) callback(null, addresses);
        else callback(null, addresses[0]?.address ?? "", addresses[0]?.family ?? 4);
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
  const client = url.protocol === "https:" ? https : http;
  return new Promise<RawResponse>((resolvePromise, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: lookup as never,
        signal,
        headers: {
          "user-agent": `forerunner ${AI_AGENT_UA_SUFFIX}`,
          accept:
            "text/html,application/xhtml+xml,text/plain,text/markdown,application/json,text/csv,application/xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          res.resume();
          resolvePromise({
            status,
            statusText: res.statusMessage ?? "",
            location,
            contentType,
            body: Buffer.alloc(0),
            truncated: false,
          });
          return;
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          encoding === "gzip" || encoding === "x-gzip"
            ? res.pipe(createGunzip())
            : encoding === "deflate"
              ? res.pipe(createInflate())
              : encoding === "br"
                ? res.pipe(createBrotliDecompress())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolvePromise({
            status,
            statusText: res.statusMessage ?? "",
            location,
            contentType,
            body: Buffer.concat(chunks),
            truncated,
          });
        };
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          if (size + chunk.byteLength > maxBytes) {
            chunks.push(chunk.subarray(0, Math.max(0, maxBytes - size)));
            size = maxBytes;
            truncated = true;
            finish();
            req.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.byteLength;
        });
        stream.on("end", finish);
        stream.on("error", (e) => {
          if (settled) return;
          settled = true;
          reject(e);
        });
      },
    );
    req.on("error", (e) => reject(e));
    req.end();
  });
}

function charsetOf(contentType: string): string {
  return /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/^"|"$/g, "") || "utf-8";
}

function decode(body: Buffer, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** Errors of a connection that never reached the site (a proxy-only network fails this way). */
const CONNECT_ERRORS = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EACCES",
  "EPERM",
]);

/**
 * Why a request ended without an answer, in words: the timeout, the network error, the refusal.
 * With a proxy set, a connection that never reached the site also says that the reader does not
 * use the proxy ('sites'), so the cause is not hidden behind "no such host".
 */
function failureWords(
  e: unknown,
  host: string,
  timeoutMs: number,
  timedOut: boolean,
  proxied: boolean,
): string {
  if (e instanceof ForerunnerError) return e.message;
  const code = (e as NodeJS.ErrnoException)?.code;
  const viaProxy = proxied && (timedOut || (code !== undefined && CONNECT_ERRORS.has(code)));
  const words = (() => {
    if (timedOut) {
      const secs = Math.max(1, Math.round(timeoutMs / 1000));
      return `${host} did not answer within ${secs} second${secs === 1 ? "" : "s"}.`;
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN")
      return `${host} was not found (no such host, or no network).`;
    if (code === "ECONNREFUSED") return `${host} refused the connection.`;
    if (code === "ECONNRESET") return `${host} closed the connection.`;
    if (code?.startsWith("ERR_TLS") || code?.includes("CERT"))
      return `${host} did not present a valid certificate (${code}).`;
    return `Could not read ${host}: ${errorMessage(e)}.`;
  })();
  return viaProxy ? `${words} ${PROXY_SENTENCE}` : words;
}

/**
 * Read one page through the rules (see the module comment). Throws `domain_not_allowed` for a
 * refusal by the rules and `unavailable` for a page that could not be read; both messages are
 * the words the model and the log read.
 */
export async function readWebPage(
  raw: string,
  opts: {
    policy: WebReadPolicy;
    signal: AbortSignal;
    maxBytes?: number;
    timeoutMs?: number;
    maxChars?: number;
    resolve?: WebResolve;
    isPublic?: (address: string) => boolean;
    /** This computer names a proxy (`proxySetIn`): a failed connection says so. */
    proxied?: boolean;
  },
): Promise<WebPageRead> {
  const maxBytes = opts.maxBytes ?? DEFAULT_WEB_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
  const resolve = opts.resolve ?? defaultResolve;
  const isPublic = opts.isPublic ?? isPublicAddress;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([opts.signal, timeout]);
  let current = raw;
  for (let hop = 0; ; hop++) {
    const d = opts.policy.checkUrl(current);
    if (!d.ok) throw refused(d.message, d.host);
    const host = d.host;
    // A connection to an IP literal resolves nothing, so the address rule is applied here.
    if (isIP(host) && !opts.policy.addressAllowed(host, host, isPublic))
      throw refused(privateAddressWords(host, host), host);
    let res: RawResponse;
    try {
      res = await getOnce(d.url, {
        policy: opts.policy,
        host,
        resolve,
        isPublic,
        signal,
        maxBytes,
      });
    } catch (e) {
      if (opts.signal.aborted) throw new ForerunnerError("killed", "run aborted");
      if (e instanceof ForerunnerError) throw e;
      // net wraps an error from `lookup` in its own; the refusal is the cause.
      const cause = (e as { cause?: unknown }).cause;
      if (cause instanceof ForerunnerError) throw cause;
      throw new ForerunnerError(
        "unavailable",
        failureWords(e, host, timeoutMs, timeout.aborted, opts.proxied === true),
        { details: { host, ...(opts.proxied ? { proxied: true } : {}) } },
      );
    }
    if (res.status >= 300 && res.status < 400) {
      if (!res.location)
        throw new ForerunnerError(
          "unavailable",
          `${host} answered a redirect (HTTP ${res.status}) without saying where to.`,
        );
      if (hop >= WEB_MAX_REDIRECTS)
        throw new ForerunnerError(
          "unavailable",
          `More than ${WEB_MAX_REDIRECTS} redirects from ${raw}; the page was not read.`,
        );
      current = new URL(res.location, d.url).toString();
      continue;
    }
    const finalUrl = d.url.toString();
    if (res.status >= 400)
      throw new ForerunnerError(
        "unavailable",
        `${finalUrl} answered HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ""}; nothing was read.`,
        { details: { status: res.status } },
      );
    const type = res.contentType.split(";")[0]?.trim().toLowerCase() || "text/html";
    if (!TEXT_TYPES.test(type))
      throw new ForerunnerError(
        "not_supported",
        `${finalUrl} is not a text page (${type}); only web pages and text can be read.`,
        { details: { contentType: type } },
      );
    const body = decode(res.body, res.contentType);
    const maxChars = opts.maxChars ?? DEFAULT_WEB_MAX_CHARS;
    if (/html/.test(type)) {
      const x = extractFromHtml(body, { url: finalUrl, maxChars, maxLinks: 40 });
      return {
        url: raw,
        finalUrl,
        status: res.status,
        contentType: type,
        title: x.title,
        text: renderExtract(x),
        truncated: res.truncated || x.truncated,
      };
    }
    const cut = body.length > maxChars;
    return {
      url: raw,
      finalUrl,
      status: res.status,
      contentType: type,
      title: "",
      text: cut ? body.slice(0, maxChars) : body,
      truncated: res.truncated || cut,
    };
  }
}

/** The tool's answer to the model: where the page came from, then its text. */
export function renderWebPage(page: WebPageRead, maxBytes = DEFAULT_WEB_MAX_BYTES): string {
  const head = `${page.finalUrl} (HTTP ${page.status}${page.title ? `, ${JSON.stringify(page.title)}` : ""})${page.finalUrl !== page.url ? `, redirected from ${page.url}` : ""}`;
  const cut = page.truncated
    ? `\n[The page was cut: only the first ${Math.round(maxBytes / 1024)} KiB or the requested characters were read.]`
    : "";
  return `${head}${cut}\n\n${page.text}`;
}

/** The `web_fetch` tool spec (see the module comment). */
export function webFetchTool(opts: WebFetchOptions): ToolSpec<{ url: string; maxChars?: number }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_WEB_MAX_BYTES;
  return {
    name: WEB_FETCH_TOOL_NAME,
    description:
      "Read one public web page by its full address (http or https) and get its text. A GET without credentials; pages on this computer or the local network are never read, and the project may limit which websites research reads. Cite every page you use by its address.",
    schema: z.object({
      url: z
        .string()
        .min(1)
        .max(WEB_MAX_URL_CHARS + 100),
      maxChars: z.number().int().min(500).max(60_000).optional(),
    }),
    actionClass: "read",
    risk: "low",
    timeoutMs: (opts.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS) * (WEB_MAX_REDIRECTS + 1) + 5_000,
    async execute(input, ctx) {
      const policy = new WebReadPolicy(await opts.rules(ctx), {
        ...(opts.loopback ? { loopback: true } : {}),
      });
      try {
        const page = await readWebPage(input.url, {
          policy,
          signal: ctx.signal,
          maxBytes,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
          ...(opts.resolve ? { resolve: opts.resolve } : {}),
          ...(opts.isPublic ? { isPublic: opts.isPublic } : {}),
          proxied: proxySetIn(opts.env ?? process.env),
        });
        return {
          content: renderWebPage(page, maxBytes),
          untrusted: { source: "web_page", origin: page.finalUrl },
          artifacts: {
            url: page.url,
            finalUrl: page.finalUrl,
            status: page.status,
            title: page.title,
            contentType: page.contentType,
            chars: page.text.length,
            truncated: page.truncated,
          },
        };
      } catch (e) {
        if (e instanceof ForerunnerError && e.code === "domain_not_allowed") {
          // The network rules refused it: on record as a refusal, with the reason.
          await opts.audit.append({
            sessionId: ctx.sessionId,
            runId: ctx.runId,
            agentId: ctx.agentId,
            humanId: ctx.humanId,
            tool: WEB_FETCH_TOOL_NAME,
            inputSummary: input.url.slice(0, 300),
            resultSummary: "",
            allowed: false,
            deniedReason: `domain_not_allowed: ${e.message}`,
            costUsdMicro: 0,
            occurredAt: opts.clock.nowIso(),
            tokenId: "",
          });
        }
        throw e;
      }
    },
  };
}

/** The host a `web_fetch` input names, for the session's step line ("read example.com/page"). */
export function webFetchTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${hostOfUrl(u)}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}
