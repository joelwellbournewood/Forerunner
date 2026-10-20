/**
 * The stand-in for an install without Chromium (ADR 0047): the same eight tool specs, where
 * `browser_navigate` fetches the page over HTTP after the same `SitePolicy.assert` the session
 * applies, follows a redirect hop by hop through the same policy and the same hop cap as the
 * session (never through `fetch`'s own follow), and `browser_read` extracts the page with the
 * static half of the same extractor (`extractFromHtml`: visible text, hidden text apart, the
 * same injection scan) and returns it marked untrusted exactly as the real tool does. Every
 * other browser tool keeps its name, class, risk and schema (so the hooks and the extension
 * gate decide on it as in the real mode) and refuses with `not_supported` when it would run:
 * there is no page to click, type into, screenshot or download from.
 *
 * The binding is resolved per run on the first navigation, as the session manager does: the
 * run token's domains as the allow list, a block list on top, so a page outside the token is
 * refused before any request leaves. Each navigation and read is an audit row through the
 * same port as the session's own rows (who, what, when, result), and the run's abort signal
 * ends the fetch.
 */
import { type Clock, errorMessage, ForerunnerError } from "@forerunner/platform";
import type { AuditPort, ToolExecutionContext, ToolSpec } from "@forerunner/runtime";
import { extractFromHtml, renderExtract } from "./extract.ts";
import { MAX_REDIRECT_HOPS, SitePolicy } from "./policy.ts";
import { AI_AGENT_UA_SUFFIX } from "./profile.ts";
import type { BindingResolver, BrowserRunBinding } from "./tools.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface StaticBrowserOptions {
  binding: BindingResolver;
  audit: AuditPort;
  clock: Clock;
  /** `globalThis.fetch` by default; tests hand in one that reaches their loopback servers. */
  fetch?: FetchLike;
  /** Cap on the bytes read from one page (default 2 MiB); the rest is dropped and reported. */
  maxBytes?: number;
  /** Per-request wall-clock limit (default 30 s). */
  timeoutMs?: number;
}

export const DEFAULT_STATIC_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_STATIC_TIMEOUT_MS = 30_000;

interface StaticPage {
  url: string;
  html: string;
  status: number;
  truncated: boolean;
}

interface StaticRun {
  policy: SitePolicy;
  binding: BrowserRunBinding;
  page: StaticPage | null;
}

/**
 * GET `url` without letting `fetch` follow anything: a 3xx answer is followed here, hop by hop,
 * each target asserted through `policy` first, at most `MAX_REDIRECT_HOPS` hops (the session's
 * cap); a redirect without a target or one hop too many is `unavailable`, as in the session.
 * Returns the final URL and its response.
 */
export async function fetchThroughPolicy(
  policy: SitePolicy,
  url: string,
  opts: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<{ url: string; res: Response }> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await doFetch(current, {
      redirect: "manual",
      headers: { "user-agent": `forerunner ${AI_AGENT_UA_SUFFIX}` },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.status < 300 || res.status >= 400) return { url: current, res };
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new ForerunnerError("unavailable", `redirect without a target (${res.status})`, {
        details: { url: current, status: res.status },
      });
    }
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new ForerunnerError("unavailable", `more than ${MAX_REDIRECT_HOPS} redirects`, {
        details: { url: current },
      });
    }
    const target = new URL(location, current).toString();
    policy.assert(target, "follow the redirect");
    current = target;
  }
}

/** Read a response body up to `maxBytes`; what follows is dropped and `truncated` says so. */
async function readBody(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, maxBytes - size)));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder("utf-8").decode(Buffer.concat(chunks)), truncated };
}

function titleOf(html: string): string {
  return /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * The real tool specs rewritten for the static mode. `real` is `browserTools(manager)` (the
 * names, classes, risks, schemas and `domainFields` stay the real ones, so the token domains
 * and the extension gate apply before anything here runs).
 */
export function staticBrowserTools(real: ToolSpec[], opts: StaticBrowserOptions): ToolSpec[] {
  const runs = new Map<string, StaticRun>();
  const maxBytes = opts.maxBytes ?? DEFAULT_STATIC_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STATIC_TIMEOUT_MS;

  const runFor = async (ctx: ToolExecutionContext): Promise<StaticRun> => {
    const existing = runs.get(ctx.runId);
    if (existing) return existing;
    if (ctx.signal.aborted) throw new ForerunnerError("killed", "run aborted");
    const binding = await opts.binding(ctx);
    const run: StaticRun = {
      binding,
      policy: new SitePolicy({
        allow: binding.allowedDomains,
        block: binding.blockedDomains ?? [],
      }),
      page: null,
    };
    runs.set(ctx.runId, run);
    ctx.signal.addEventListener("abort", () => runs.delete(ctx.runId), { once: true });
    return run;
  };
  const audit = async (
    ctx: ToolExecutionContext,
    run: StaticRun | null,
    tool: string,
    input: string,
    outcome: { result: string } | { denied: string },
  ): Promise<void> => {
    await opts.audit.append({
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      humanId: ctx.humanId,
      tool,
      inputSummary: input.slice(0, 300),
      resultSummary: "result" in outcome ? outcome.result.slice(0, 300) : "",
      allowed: "result" in outcome,
      deniedReason: "denied" in outcome ? outcome.denied : undefined,
      costUsdMicro: 0,
      occurredAt: opts.clock.nowIso(),
      tokenId: run?.binding.tokenId ?? "",
    });
  };

  return real.map((spec) => {
    if (spec.name === "browser_navigate") {
      const navigate: ToolSpec<{ url: string }> = {
        ...(spec as ToolSpec<{ url: string }>),
        async execute(input, ctx) {
          const run = await runFor(ctx);
          try {
            run.policy.assert(input.url, "navigate");
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
            const { url, res } = await fetchThroughPolicy(run.policy, input.url, {
              fetch: opts.fetch,
              signal,
            });
            const body = await readBody(res, maxBytes);
            run.page = { url, html: body.text, status: res.status, truncated: body.truncated };
            const title = titleOf(body.text);
            const result = `Opened ${url} (HTTP ${res.status}) ${JSON.stringify(title)}.${body.truncated ? ` The page was cut at ${maxBytes} bytes.` : ""}`;
            await audit(ctx, run, spec.name, input.url, { result });
            return { content: result };
          } catch (e) {
            const code = e instanceof ForerunnerError ? e.code : "unavailable";
            await audit(ctx, run, spec.name, input.url, { denied: `${code}: ${errorMessage(e)}` });
            throw e;
          }
        },
      };
      return navigate as ToolSpec;
    }
    if (spec.name === "browser_read") {
      const read: ToolSpec<{ maxChars?: number }> = {
        ...(spec as ToolSpec<{ maxChars?: number }>),
        async execute(input, ctx) {
          const run = runs.get(ctx.runId);
          const page = run?.page;
          if (!run || !page) {
            return {
              content: "no browser page is open for this run: call browser_navigate first",
              isError: true,
            };
          }
          const x = extractFromHtml(page.html, { url: page.url, maxChars: input.maxChars });
          await audit(ctx, run, spec.name, page.url, {
            result: `${x.hidden.length} hidden passage(s)${x.suspicious ? "; injection suspected" : ""}${x.truncated || page.truncated ? "; truncated" : ""}`,
          });
          return {
            content: renderExtract(x),
            untrusted: { source: "web_page", origin: x.url },
            artifacts: {
              suspicious: x.suspicious,
              hidden: x.hidden.length,
              truncated: x.truncated || page.truncated,
            },
          };
        },
      };
      return read as ToolSpec;
    }
    if (spec.name === "browser_close") {
      const close: ToolSpec<Record<string, never>> = {
        ...(spec as ToolSpec<Record<string, never>>),
        async execute(_input, ctx) {
          if (!runs.delete(ctx.runId)) return { content: "No browser session was open." };
          return { content: "Browser session closed." };
        },
      };
      return close as ToolSpec;
    }
    const unavailable: ToolSpec = {
      ...spec,
      async execute(_input, ctx) {
        await audit(ctx, runs.get(ctx.runId) ?? null, spec.name, "", {
          denied: `not_supported: ${spec.name} needs the sandboxed browser`,
        });
        throw new ForerunnerError(
          "not_supported",
          `${spec.name} needs the sandboxed browser; this install runs the static page reader (no Chromium found)`,
          { details: { tool: spec.name } },
        );
      },
    };
    return unavailable;
  });
}
