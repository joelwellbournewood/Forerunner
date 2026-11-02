import { errorMessage, redact } from "@forerunner/platform";
import type { JsonObject } from "@forerunner/state";
import { ToolRegistry, type ToolSpec } from "../agent/tools.ts";
import { WEB_FETCH_TOOL } from "../registry/tools.ts";

/**
 * The web pages a run read, kept for the critic (ADR 0107): a researcher's answer cites pages,
 * and the critic checks each cited claim against the text the specialist actually got, not
 * against the specialist's word for it. The executor wraps the run's `web_fetch` with
 * `withWebSourceLog`; the critic port turns the log into the review's input files
 * (`webSourceEvidence`), and the Run row keeps the addresses (`webSourceArtifact`).
 */
export interface WebSource {
  /** The address the specialist asked for. */
  url: string;
  /** Where the page came from after redirects. */
  finalUrl?: string;
  status?: number;
  title?: string;
  /** The text the specialist got (redacted, at most `MAX_SOURCE_CHARS`). */
  text?: string;
  /** Why it was not read, in words: a refusal by the network rules, an error status, a timeout. */
  error?: string;
}

/** Characters of one page the critic gets; a cited passage is near the top or quoted. */
export const MAX_SOURCE_CHARS = 8_000;
/** Pages kept per run; a run that reads more is listed by address beyond these. */
export const MAX_SOURCES = 12;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * `tools` with its `web_fetch` (if any) wrapped so every call is appended to `log`: the page's
 * address, status, title and text on success, the words of the refusal or error otherwise. The
 * call itself is unchanged: same spec, same result, same error.
 */
export function withWebSourceLog(tools: ToolRegistry, log: WebSource[]): ToolRegistry {
  const fetch = tools.get(WEB_FETCH_TOOL) as ToolSpec<{ url: string }> | undefined;
  if (!fetch) return tools;
  const out = new ToolRegistry();
  for (const name of tools.names()) {
    const t = tools.get(name);
    if (t && name !== WEB_FETCH_TOOL) out.register(t);
  }
  const logged: ToolSpec<{ url: string }> = {
    ...fetch,
    async execute(input, ctx) {
      try {
        const r = await fetch.execute(input, ctx);
        const a = r.artifacts ?? {};
        log.push({
          url: input.url,
          ...(str(a.finalUrl) ? { finalUrl: str(a.finalUrl) } : {}),
          ...(typeof a.status === "number" ? { status: a.status } : {}),
          ...(str(a.title) ? { title: str(a.title) } : {}),
          ...(r.isError
            ? { error: redact(r.content).slice(0, 300) }
            : { text: redact(r.content).slice(0, MAX_SOURCE_CHARS) }),
        });
        return r;
      } catch (e) {
        log.push({ url: input.url, error: redact(errorMessage(e)).slice(0, 300) });
        throw e;
      }
    },
  };
  out.register(logged);
  return out;
}

/** What the Run row keeps: the addresses and how each went, never the page text. */
export function webSourceArtifact(log: readonly WebSource[]): JsonObject {
  return {
    webSources: log.map(
      (s): JsonObject =>
        s.error
          ? { url: s.url, error: s.error }
          : {
              url: s.url,
              ...(s.finalUrl && s.finalUrl !== s.url ? { finalUrl: s.finalUrl } : {}),
              ...(s.status !== undefined ? { status: s.status } : {}),
              ...(s.title ? { title: s.title } : {}),
            },
    ),
  };
}

/**
 * The review's evidence from the pages a run read: each page read as an input file named by its
 * address (the critic's evidence renders input files as data, ADR 0042), and one artifact line
 * per page that could not be read, so a cited source the specialist never got is visible.
 */
export function webSourceEvidence(log: readonly WebSource[] | undefined): {
  inputFiles: { path: string; content: string }[];
  artifacts: string[];
} {
  const inputFiles: { path: string; content: string }[] = [];
  const artifacts: string[] = [];
  const seen = new Set<string>();
  for (const s of log ?? []) {
    if (s.error) {
      artifacts.push(`web page not read: ${s.url} (${s.error})`);
      continue;
    }
    const where = s.finalUrl ?? s.url;
    if (seen.has(where)) continue;
    seen.add(where);
    if (inputFiles.length >= MAX_SOURCES) {
      artifacts.push(`web page read (text not included, over ${MAX_SOURCES} pages): ${where}`);
      continue;
    }
    inputFiles.push({ path: `web page ${where}`, content: s.text ?? "" });
  }
  return { inputFiles, artifacts };
}
